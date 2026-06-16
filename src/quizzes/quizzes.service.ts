import { Injectable, BadRequestException, ForbiddenException, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FilesService } from '../files/files.service';
import { BillingService } from '../billing/billing.service';
import { EnvService } from '../env/env.service';
import { GeminiService } from '../env/gemini.service';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';
import { quizResponseSchema } from './schemas/quiz.schema';
import { GenerateQuizDto } from './dto/generate-quiz.dto';
import { SubmitAnswerDto } from './dto/submit-answer.dto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PDFDocument } from 'pdf-lib';
import { AppLanguage, QuizGenerationJobStatus, QuizGenerationSourceType } from '@prisma/client'
import { CreditCostType, PlanType, calculateCreditsForUnits, getMaxQuestionsPerDeckForPlan } from '../config/plan-limits';
import { QuizGenerationQueueService } from './quiz-generation.queue.service';

const APP_LANGUAGE_LABELS: Record<AppLanguage, string> = {
  en: 'English',
  zh: 'Chinese',
  hi: 'Hindi',
  es: 'Spanish',
  fr: 'French',
  tr: 'Turkish',
  pt: 'Portuguese'
};

type StudySessionWithQuiz = Prisma.StudySessionGetPayload<{
  include: {
    questionProgress: true;
    quiz: {
      include: {
        questions: true;
      };
    };
  };
}>;

type QuizQuestionWithGradingContext = StudySessionWithQuiz['quiz']['questions'][number] & {
  gradingContext?: string | null;
  topic?: string | null;
};

type StudySessionWithQuizFiles = Prisma.StudySessionGetPayload<{
  include: {
    questionProgress: true;
    quiz: {
      include: {
        questions: true;
        files: true;
      };
    };
  };
}> & {
  quiz: StudySessionWithQuiz['quiz'] & {
    gradingContext?: string | null;
    questions: QuizQuestionWithGradingContext[];
  };
};

const shortAnswerEvaluationSchema = z.object({
  score: z.number().min(0).max(100),
  isCorrect: z.boolean(),
  feedback: z.string().min(1).max(1200),
});

type GenerateQuizJobPayload = GenerateQuizDto;

@Injectable()
export class QuizzesService {
  private readonly logger = new Logger(QuizzesService.name);
  private appBaseUrl: string;
  private readonly processedAttempts = new Map<string, number>();
  private readonly processedAttemptTtlMs = 30 * 60 * 1000;
  private readonly defaultBatchSize = 5;
  private readonly maxBatchSize = 50;
  private readonly shortAnswerPassingScore = 70;

  private readonly systemPrompt = `You are an expert educational content creator. Analyze the provided study source material and generate quiz questions categorized by Bloom's Taxonomy cognitive tiers:

- Tier 1 "recall": Basic memorization (e.g. "What year was X founded?", "What is the formula for Y?")
- Tier 2 "application": Using a concept in a straightforward scenario (e.g. "Calculate the velocity using the formula")
- Tier 3 "analysis": Connecting multiple concepts or evaluating tradeoffs (e.g. "Why did approach A fail compared to approach B?")

Also compute a Rigor Index (0-100): a weighted score where recall questions contribute 30 points worth of weight, application 60, and analysis 100. Average across all questions. A recall-only quiz scores ~30, a balanced mix ~60, heavy analysis/application pushes toward 85-100.

Guidelines:
- Structured user preferences are authoritative. If question count, tier preference, or format preference is provided, follow it exactly.
- If no user preference is provided, default to 8 questions with a balanced mix of tiers and formats.
- If the source includes images or scanned pages, extract the clearly visible text faithfully and base questions only on information that is actually present or directly inferable from the source.
- Do not invent missing, unreadable, or obscured text from an image.
- Use one of these JSON format values for each question: multiple_choice, flashcard, short_answer
- For multiple_choice only: include exactly 4 options
- For flashcard and short_answer: do not include options
- Provide a clear explanation for each answer
- Provide a deck-level gradingContext that summarizes the key concepts, acceptable paraphrases, and what matters most when grading answers for this deck
- Provide a gradingContext for each question that captures the specific facts or reasoning needed to grade that question without re-reading the original source`;

  constructor(
    private prisma: PrismaService,
    private filesService: FilesService,
    private billing: BillingService,
    private env: EnvService,
    private gemini: GeminiService,
    private generationQueue: QuizGenerationQueueService,
  ) {
    this.appBaseUrl = env.appBaseUrl;
  }

  private mapGenerationJob(job: {
    id: string;
    status: QuizGenerationJobStatus;
    sourceType: QuizGenerationSourceType;
    payload: Prisma.JsonValue;
    title?: string | null;
    estimatedCredits: number;
    resultQuizId?: string | null;
    errorMessage?: string | null;
    attempts: number;
    startedAt?: Date | null;
    completedAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    const payload = this.parseGenerationJobPayload(job.payload);

    return {
      id: job.id,
      status: job.status,
      sourceType: job.sourceType,
      title: job.title || 'Untitled deck',
      subject: payload.subject || null,
      questionCount: payload.questionCount || null,
      questionTier: payload.questionTier || 'mixed',
      questionFormat: payload.questionFormat || 'mixed',
      estimatedCredits: job.estimatedCredits,
      resultQuizId: job.resultQuizId,
      errorMessage: job.errorMessage,
      attempts: job.attempts,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }

  private getGenerationSourceType(dto: GenerateQuizDto): QuizGenerationSourceType {
    if (dto.audioFileId) {
      return QuizGenerationSourceType.audio;
    }

    if (dto.text && dto.text.trim().length > 0) {
      return QuizGenerationSourceType.text;
    }

    return QuizGenerationSourceType.files;
  }

  private buildGenerationJobPayload(dto: GenerateQuizDto): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(dto ?? {})) as Prisma.InputJsonValue;
  }

  private parseGenerationJobPayload(payload: Prisma.JsonValue): GenerateQuizJobPayload {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new InternalServerErrorException('Generation job payload is invalid.');
    }

    return payload as unknown as GenerateQuizJobPayload;
  }

  private getGenerationErrorMessage(error: unknown) {
    if (error instanceof Error && error.message) {
      return error.message.slice(0, 1000);
    }

    return 'Generation failed.';
  }

  private async buildDeckFromSource(userId: string, dto: GenerateQuizDto) {
    if (dto.audioFileId) {
      return this.generateFromAudio(userId, dto);
    }

    if (dto.text && dto.text.trim().length > 0) {
      return this.generateFromText(userId, dto);
    }

    return this.generateFromFiles(userId, dto);
  }

  private toAvatarUrl(userId?: string | null, value?: string | null) {
    if (!userId || !value) {
      return null;
    }

    return `${this.appBaseUrl}/users/${encodeURIComponent(userId)}/avatar`;
  }

  private withDeckFilePublicUrls<T extends { files?: Array<{ r2Key?: string | null }> }>(deck: T): T {
    const files = Array.isArray(deck.files)
      ? deck.files.map((file) => ({
          ...file,
        }))
      : deck.files;

    const user =
      deck && typeof deck === 'object' && 'user' in deck && deck.user && typeof deck.user === 'object'
        ? {
            ...(deck.user as Record<string, unknown>),
            avatarUrl: this.toAvatarUrl(
              (deck.user as { id?: string | null }).id,
              (deck.user as { avatarUrl?: string | null }).avatarUrl,
            ),
          }
        : undefined;

    return {
      ...deck,
      ...(files ? { files } : {}),
      ...(user ? { user } : {}),
    };
  }

  private async ensureSessionQuestionProgress(sessionId: string, questionQueue: string[]) {
    if (!questionQueue.length) {
      return;
    }

    await this.prisma.studySessionQuestionProgress.createMany({
      data: questionQueue.map((questionId) => ({
        sessionId,
        questionId,
      })),
      skipDuplicates: true,
    });
  }

  private buildDeckAccessWhere(userId: string, quizId: string): Prisma.GeneratedQuizWhereInput {
    return {
      id: quizId,
      OR: [
        { userId },
        { saves: { some: { userId } } },
        {isPublic : true}
      ],
    };
  }

  private buildFallbackExplanation(question: {
    format?: string;
    question?: string;
    correctAnswer?: string;
    explanation?: string | null;
  }) {
    const existingExplanation = String(question.explanation || '').trim();
    if (existingExplanation) {
      return existingExplanation;
    }

    const prompt = String(question.question || '').trim();
    const answer = String(question.correctAnswer || '').trim();

    if (question.format === 'flashcard') {
      if (prompt && answer) {
        return `This flashcard links "${prompt}" to "${answer}" as the key idea to remember.`;
      }

      if (answer) {
        return `The key concept to remember is "${answer}".`;
      }

      return 'This flashcard reinforces the key concept from the source material.';
    }

    if (question.format === 'short_answer') {
      if (answer) {
        return `The expected answer is "${answer}" based on the source material.`;
      }

      return 'The expected answer follows directly from the source material.';
    }

    if (answer) {
      return `The correct answer is "${answer}" because it best matches the source material.`;
    }

    return 'This answer is correct based on the source material.';
  }

  private buildFallbackQuestionGradingContext(question: {
    format?: string;
    question?: string;
    correctAnswer?: string;
    explanation?: string | null;
    gradingContext?: string | null;
    topic?: string | null;
  }) {
    const existingContext = String(question.gradingContext || '').trim();
    if (existingContext) {
      return existingContext;
    }

    const topic = String(question.topic || '').trim();
    const prompt = String(question.question || '').trim();
    const answer = String(question.correctAnswer || '').trim();
    const explanation = this.buildFallbackExplanation(question);

    return [
      topic ? `Topic: ${topic}.` : null,
      prompt ? `Question focus: ${prompt}` : null,
      answer ? `Expected core answer: ${answer}.` : null,
      explanation ? `Reference rationale: ${explanation}` : null,
      'Accept equivalent phrasing and concise paraphrases when the same concept is expressed accurately.',
    ].filter(Boolean).join(' ');
  }

  private buildFallbackDeckGradingContext(
    questions: Array<{ topic?: string | null }> = [],
    gradingContext?: string | null,
  ) {
    const existingContext = String(gradingContext || '').trim();
    if (existingContext) {
      return existingContext;
    }

    const topics = Array.from(
      new Set(
        questions
          .map((question) => String(question.topic || '').trim())
          .filter(Boolean),
      ),
    ).slice(0, 8);

    const topicSummary = topics.length
      ? `Key deck topics: ${topics.join(', ')}.`
      : 'Use the question-specific grading context as the primary source of truth.';

    return `${topicSummary} Grade for conceptual correctness rather than exact wording, accept sound paraphrases, and reject answers that contradict the underlying facts or reasoning.`;
  }

  private normalizePageSelections(fileIds: string[] | undefined, pageSelections: unknown) {
    const normalized = new Map<string, number[]>();

    if (!Array.isArray(fileIds) || !fileIds.length || !pageSelections || typeof pageSelections !== 'object') {
      return normalized;
    }

    const selectionRecord = pageSelections as Record<string, unknown>;

    for (const fileId of fileIds) {
      const selectedPages = selectionRecord[fileId];

      if (!Array.isArray(selectedPages)) {
        continue;
      }
      
      // Normalize to unique, sorted, positive integers, using a Set to ensure uniqueness and filtering out invalid values.
      const pages = Array.from(
        new Set(
          selectedPages
            .map((page) => Number(page))
            .filter((page) => Number.isInteger(page) && page > 0),
        ),
      ).sort((left, right) => left - right);

      if (pages.length) {
        normalized.set(fileId, pages);
      }
    }

    return normalized;
  }

  private async buildPdfBufferForGeneration(buffer: Buffer, selectedPages: number[]) {
    if (!selectedPages.length) {
      return buffer;
    }

    const sourceDocument = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const pageCount = sourceDocument.getPageCount();
    const zeroBasedIndexes = selectedPages
      .filter((page) => page <= pageCount)
      .map((page) => page - 1);

    if (!zeroBasedIndexes.length) {
      throw new BadRequestException('Selected pages are outside the PDF page range');
    }

    const isFullDocumentSelection =
      zeroBasedIndexes.length === pageCount && zeroBasedIndexes.every((pageIndex, index) => pageIndex === index);

    if (isFullDocumentSelection) {
      return buffer;
    }

    const outputDocument = await PDFDocument.create();
    const copiedPages = await outputDocument.copyPages(sourceDocument, zeroBasedIndexes);

    for (const page of copiedPages) {
      outputDocument.addPage(page);
    }

    const outputBytes = await outputDocument.save();
    return Buffer.from(outputBytes);
  }

  private buildGenerationDisplayName(originalName: string, selectedPages: number[]) {
    if (!selectedPages.length) {
      return originalName;
    }

    return `${originalName} (pages ${selectedPages.join(', ')})`;
  }

  private async getUserPreferredLanguage(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { preferredLanguage: true } as any,
    }) as { preferredLanguage?: AppLanguage } | null;

    return user?.preferredLanguage ?? 'en';
  }

  private normalizeGeneratedQuizData(payload: unknown) {
    if (!payload || typeof payload !== 'object') {
      return payload;
    }

    const candidate = payload as { quizzes?: unknown[]; gradingContext?: unknown };
    if (!Array.isArray(candidate.quizzes)) {
      return payload;
    }

    const normalizedQuestions = candidate.quizzes.map((question) => {
      if (!question || typeof question !== 'object') {
        return question;
      }

      const questionWithFallbacks = {
        ...question,
        explanation: this.buildFallbackExplanation(
          question as {
            format?: string;
            question?: string;
            correctAnswer?: string;
            explanation?: string | null;
          },
        ),
      };

      return {
        ...questionWithFallbacks,
        gradingContext: this.buildFallbackQuestionGradingContext(
          questionWithFallbacks as {
            format?: string;
            question?: string;
            correctAnswer?: string;
            explanation?: string | null;
            gradingContext?: string | null;
            topic?: string | null;
          },
        ),
      };
    });

    return {
      ...candidate,
      gradingContext: this.buildFallbackDeckGradingContext(
        normalizedQuestions as Array<{ topic?: string | null }>,
        typeof candidate.gradingContext === 'string' ? candidate.gradingContext : undefined,
      ),
      quizzes: normalizedQuestions,
    };
  }

  private assertQuestionCountWithinPlanLimit(questionCount: number | undefined, plan: string) {
    if (!questionCount) {
      return;
    }

    const maxQuestionCount = getMaxQuestionsPerDeckForPlan(plan);

    if (questionCount > maxQuestionCount) {
      throw new BadRequestException(`Your current plan allows up to ${maxQuestionCount} questions per deck.`);
    }
  }

  async generate(userId: string, dto: GenerateQuizDto) {
    const generationCreditCost = this.getQuizGenerationCreditCost(dto);
    const affordability = await this.billing.canAffordCredits(userId, generationCreditCost);

    this.assertQuestionCountWithinPlanLimit(dto.questionCount, affordability.plan);

    if (!affordability.canAfford) {
       return {
          status: 'credits_needed',
          requiredCredits: generationCreditCost,
          remainingCredits: affordability.remainingCredits,
          monthlyCredits: affordability.monthlyCredits,
        };
    }

    const createdDeck = await this.buildDeckFromSource(userId, dto);

    try {
      await this.billing.consumeCredits(userId, generationCreditCost, 'Quiz generation');
    } catch (error) {
      if (createdDeck?.id) {
        await this.prisma.generatedQuiz.delete({ where: { id: createdDeck.id } }).catch(() => {});
      }
      throw error;
    }

    return createdDeck;
  }

  async enqueueGeneration(userId: string, dto: GenerateQuizDto) {
    const generationCreditCost = this.getQuizGenerationCreditCost(dto);
    const affordability = await this.billing.canAffordCredits(userId, generationCreditCost);

    this.assertQuestionCountWithinPlanLimit(dto.questionCount, affordability.plan);

    if (!affordability.canAfford) {
      return {
        status: 'credits_needed',
        requiredCredits: generationCreditCost,
        remainingCredits: affordability.remainingCredits,
        monthlyCredits: affordability.monthlyCredits,
      };
    }

    const createdJob = await this.prisma.quizGenerationJob.create({
      data: {
        userId,
        status: QuizGenerationJobStatus.queued,
        sourceType: this.getGenerationSourceType(dto),
        payload: this.buildGenerationJobPayload(dto),
        title: dto.title?.trim() || null,
        estimatedCredits: generationCreditCost,
      },
    });

    try {
      await this.generationQueue.enqueueGenerationJob(createdJob.id);
    } catch (error) {
      await this.prisma.quizGenerationJob.update({
        where: { id: createdJob.id },
        data: {
          status: QuizGenerationJobStatus.failed,
          errorMessage: this.getGenerationErrorMessage(error),
          completedAt: new Date(),
          attempts: 1,
        },
      }).catch(() => {});

      throw new InternalServerErrorException('Could not queue quiz generation.');
    }

    return this.mapGenerationJob(createdJob);
  }

  async listGenerationJobs(userId: string) {
    const jobs = await this.prisma.quizGenerationJob.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    return jobs.map((job) => this.mapGenerationJob(job));
  }

  async getGenerationJob(userId: string, jobId: string) {
    const job = await this.prisma.quizGenerationJob.findFirst({
      where: { id: jobId, userId },
    });

    if (!job) {
      throw new NotFoundException('Generation job not found');
    }

    return this.mapGenerationJob(job);
  }

  async processGenerationJob(jobId: string) {
    const transition = await this.prisma.quizGenerationJob.updateMany({
      where: {
        id: jobId,
        status: QuizGenerationJobStatus.queued,
      },
      data: {
        status: QuizGenerationJobStatus.processing,
        startedAt: new Date(),
        attempts: {
          increment: 1,
        },
        errorMessage: null,
        completedAt: null,
      },
    });

    if (transition.count === 0) {
      return;
    }

    const job = await this.prisma.quizGenerationJob.findUnique({
      where: { id: jobId },
    });

    if (!job) {
      throw new NotFoundException('Generation job not found');
    }

    const dto = this.parseGenerationJobPayload(job.payload);

    try {
      const createdDeck = await this.buildDeckFromSource(job.userId, dto);

      try {
        await this.billing.consumeCredits(job.userId, job.estimatedCredits, 'Quiz generation');
      } catch (error) {
        if (createdDeck?.id) {
          await this.prisma.generatedQuiz.delete({ where: { id: createdDeck.id } }).catch(() => {});
        }
        throw error;
      }

      await this.prisma.quizGenerationJob.update({
        where: { id: job.id },
        data: {
          status: QuizGenerationJobStatus.completed,
          resultQuizId: createdDeck.id,
          completedAt: new Date(),
          errorMessage: null,
        },
      });
    } catch (error) {
      const message = this.getGenerationErrorMessage(error);
      this.logger.error(`Quiz generation job ${job.id} failed: ${message}`);

      await this.prisma.quizGenerationJob.update({
        where: { id: job.id },
        data: {
          status: QuizGenerationJobStatus.failed,
          errorMessage: message,
          completedAt: new Date(),
        },
      }).catch(() => {});

      throw error;
    }
  }

  private async generateFromFiles(userId: string, dto: GenerateQuizDto) {
    if (!dto.fileIds || dto.fileIds.length === 0) {
      throw new BadRequestException('Either fileIds, audioFileId, or text is required');
    }

    const pageSelectionsByFileId = this.normalizePageSelections(dto.fileIds, dto.pageSelections);
    const generationLanguage = await this.getUserPreferredLanguage(userId);

    // Upload all files to Gemini
    const uploadedFiles: Array<{ name: string; uri: string; mimeType: string }> = [];
    const tempPaths: string[] = [];

    try {
      // Upload each file
      for (const fileId of dto.fileIds) {
        const { buffer, mimeType, originalName } = await this.filesService.getFileBuffer(fileId);
        const selectedPages = pageSelectionsByFileId.get(fileId) ?? [];
        const generationBuffer = mimeType === 'application/pdf'
          ? await this.buildPdfBufferForGeneration(buffer, selectedPages)
          : buffer;
        const displayName = this.buildGenerationDisplayName(originalName, selectedPages);
        const tempPath = path.join(os.tmpdir(), `${Date.now()}-${fileId}-${originalName}`);
        fs.writeFileSync(tempPath, generationBuffer);
        tempPaths.push(tempPath);

        const uploadedFile = await this.gemini.uploadFile({
          file: tempPath,
          config: { mimeType, displayName },
        });
        uploadedFiles.push({
          name: uploadedFile.name,
          uri: uploadedFile.uri,
          mimeType,
        });
      }

      const prompt = this.buildPrompt(dto, generationLanguage);

      // Generate quiz from all files
      const response = await this.gemini.generateContent({
        contents: [
          {
            parts: [
              ...uploadedFiles.map(f => ({ fileData: { mimeType: f.mimeType, fileUri: f.uri } })),
              { text: prompt },
            ],
          },
        ],
        config: {
          responseMimeType: 'application/json',
          responseJsonSchema: zodToJsonSchema(quizResponseSchema as any),
        },
      });

      const quizData = quizResponseSchema.parse(this.normalizeGeneratedQuizData(JSON.parse(response.text)));
      const generatedQuestionCount = quizData.quizzes.length;
      const generatedTiers = Array.from(new Set(quizData.quizzes.map((q) => q.tier)));
      const generatedFormats = Array.from(new Set(quizData.quizzes.map((q) => q.format)));

      // Create quiz with questions and file associations
      const createdDeck = await this.prisma.generatedQuiz.create({
        data: {
          userId,
          rigorIndex: quizData.rigorIndex,
          gradingContext: quizData.gradingContext,
          title: dto.title || `Untitled Quiz ${new Date().toLocaleString()}`,
          subject: dto.subject || undefined,
          language: generationLanguage,
          questionCount: dto.questionCount || generatedQuestionCount,
          questionTier: dto.questionTier || (generatedTiers.length > 1 ? 'mixed' : generatedTiers[0]),
          questionFormat: dto.questionFormat || (generatedFormats.length > 1 ? 'mixed' : generatedFormats[0]),
          files: {
            connect: (dto.fileIds || []).map(fileId => ({ id: fileId })),
          },
          questions: {
            create: quizData.quizzes.map((q, index) => ({
              format: q.format,
              question: q.question,
              options: q.format === 'multiple_choice' ? q.options : [],
              correctAnswer: q.correctAnswer,
              explanation: q.explanation,
              gradingContext: q.gradingContext,
              tier: q.tier,
              topic: q.topic,
              orderIndex: index,
            })),
          },
        },
        include: {
          questions: { orderBy: { orderIndex: 'asc' } },
          files: { select: { id: true, originalName: true, r2Key: true } },
        },
      });

      return this.withDeckFilePublicUrls(createdDeck);
    } finally {
      // Cleanup temp files
      for (const tempPath of tempPaths) {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      }
      // Cleanup uploaded files from Gemini
      for (const uploadedFile of uploadedFiles) {
        await this.gemini.deleteFile({ name: uploadedFile.name }).catch(() => {});
      }
    }
  }

  private async generateFromAudio(userId: string, dto: GenerateQuizDto) {
    const { buffer, mimeType, originalName } = await this.filesService.getFileBuffer(dto.audioFileId);
    const generationLanguage = await this.getUserPreferredLanguage(userId);
    const tempPath = path.join(os.tmpdir(), `${Date.now()}-${originalName}`);
    let uploadedFileName: string | null = null;

    try {
      fs.writeFileSync(tempPath, buffer);

      // Upload audio to Gemini File API
      const uploadedFile = await this.gemini.uploadFile({
        file: tempPath,
        config: { mimeType, displayName: originalName },
      });
      uploadedFileName = uploadedFile.name;

      // Step 1: Transcribe the audio using Gemini
      const transcriptionResponse = await this.gemini.generateContent({
        contents: [
          {
            parts: [
              { fileData: { mimeType, fileUri: uploadedFile.uri } },
              { text: 'Transcribe this audio completely and accurately. Output only the transcript text, preserving the original language. Include speaker labels if multiple speakers are detected. Do not add any commentary or formatting beyond the transcript itself.' },
            ],
          },
        ],
      });

      const transcript = transcriptionResponse.text?.trim();
      if (!transcript) {
        throw new BadRequestException('Could not transcribe the audio file. Please try a clearer recording.');
      }

      // Step 2: Generate quiz from transcript
      const prompt = this.buildPrompt(dto, generationLanguage);
      const quizPrompt = `The following is a transcript from an audio recording. Use it as the source material to generate quiz questions.\n\n--- TRANSCRIPT START ---\n${transcript}\n--- TRANSCRIPT END ---\n\n${prompt}`;

      const quizResponse = await this.gemini.generateContent({
        contents: [{ parts: [{ text: quizPrompt }] }],
        config: {
          responseMimeType: 'application/json',
          responseJsonSchema: zodToJsonSchema(quizResponseSchema as any),
        },
      });

      const quizData = quizResponseSchema.parse(this.normalizeGeneratedQuizData(JSON.parse(quizResponse.text)));
      const generatedQuestionCount = quizData.quizzes.length;
      const generatedTiers = Array.from(new Set(quizData.quizzes.map((q) => q.tier)));
      const generatedFormats = Array.from(new Set(quizData.quizzes.map((q) => q.format)));

      const createdDeck = await this.prisma.generatedQuiz.create({
        data: {
          userId,
          rigorIndex: quizData.rigorIndex,
          gradingContext: quizData.gradingContext,
          title: dto.title || `Untitled Quiz ${new Date().toLocaleString()}`,
          subject: dto.subject || undefined,
          language: generationLanguage,
          questionCount: dto.questionCount || generatedQuestionCount,
          questionTier: dto.questionTier || (generatedTiers.length > 1 ? 'mixed' : generatedTiers[0]),
          questionFormat: dto.questionFormat || (generatedFormats.length > 1 ? 'mixed' : generatedFormats[0]),
          files: {
            connect: [{ id: dto.audioFileId }],
          },
          questions: {
            create: quizData.quizzes.map((q, index) => ({
              format: q.format,
              question: q.question,
              options: q.format === 'multiple_choice' ? q.options : [],
              correctAnswer: q.correctAnswer,
              explanation: q.explanation,
              gradingContext: q.gradingContext,
              tier: q.tier,
              topic: q.topic,
              orderIndex: index,
            })),
          },
        },
        include: {
          questions: { orderBy: { orderIndex: 'asc' } },
          files: { select: { id: true, originalName: true, r2Key: true } },
        },
      });

      return this.withDeckFilePublicUrls(createdDeck);
    } finally {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
      if (uploadedFileName) {
        await this.gemini.deleteFile({ name: uploadedFileName }).catch(() => {});
      }
    }
  }

  private async generateFromText(userId: string, dto: GenerateQuizDto) {
    const sourceText = dto.text?.trim();
    if (!sourceText) {
      throw new BadRequestException('text is required');
    }

    const generationLanguage = await this.getUserPreferredLanguage(userId);
    const prompt = this.buildPrompt(dto, generationLanguage);
    const fullPrompt = `The following is study material pasted by the user (notes, lecture text, article, etc.). Use it as the sole source material to generate quiz questions. Do not invent facts that are not supported by the text.\n\n--- USER NOTES START ---\n${sourceText}\n--- USER NOTES END ---\n\n${prompt}`;

    const quizResponse = await this.gemini.generateContent({
      contents: [{ parts: [{ text: fullPrompt }] }],
      config: {
        responseMimeType: 'application/json',
        responseJsonSchema: zodToJsonSchema(quizResponseSchema as any),
      },
    });

    const quizData = quizResponseSchema.parse(this.normalizeGeneratedQuizData(JSON.parse(quizResponse.text)));
    const generatedQuestionCount = quizData.quizzes.length;
    const generatedTiers = Array.from(new Set(quizData.quizzes.map((q) => q.tier)));
    const generatedFormats = Array.from(new Set(quizData.quizzes.map((q) => q.format)));

    const createdDeck = await this.prisma.generatedQuiz.create({
      data: {
        userId,
        rigorIndex: quizData.rigorIndex,
        gradingContext: quizData.gradingContext,
        title: dto.title || `Untitled Quiz ${new Date().toLocaleString()}`,
        subject: dto.subject || undefined,
        language: generationLanguage,
        questionCount: dto.questionCount || generatedQuestionCount,
        questionTier: dto.questionTier || (generatedTiers.length > 1 ? 'mixed' : generatedTiers[0]),
        questionFormat: dto.questionFormat || (generatedFormats.length > 1 ? 'mixed' : generatedFormats[0]),
        questions: {
          create: quizData.quizzes.map((q, index) => ({
            format: q.format,
            question: q.question,
            options: q.format === 'multiple_choice' ? q.options : [],
            correctAnswer: q.correctAnswer,
            explanation: q.explanation,
            gradingContext: q.gradingContext,
            tier: q.tier,
            topic: q.topic,
            orderIndex: index,
          })),
        },
      },
      include: {
        questions: { orderBy: { orderIndex: 'asc' } },
        files: { select: { id: true, originalName: true, r2Key: true } },
      },
    });

    return this.withDeckFilePublicUrls(createdDeck);
  }

  private getQuizGenerationCreditCost(dto: GenerateQuizDto): number {
    let totalCredits = calculateCreditsForUnits(CreditCostType.QUIZ_GENERATION, 1);

    const sourceText = dto.text?.trim();
    if (sourceText) {
      totalCredits += calculateCreditsForUnits(CreditCostType.TEXT_CHARACTERS, sourceText.length);
    }

    return totalCredits;
  }

  private buildPrompt(dto: GenerateQuizDto, language: AppLanguage = 'en') {
    const lines = [this.systemPrompt];

    lines.push(
      '',
      `Language requirement: write the generated deck title, grading context, questions, answer options, correct answers, and explanations entirely in ${APP_LANGUAGE_LABELS[language]}.`,
      'Do not translate any previously created quiz content. This requirement only applies to the new quiz being generated now.',
    );

    if (dto.questionCount || dto.questionTier || dto.questionFormat) {
      lines.push('', 'Authoritative user preferences (must be followed):');

      if (dto.questionCount) {
        lines.push(`- Generate exactly ${dto.questionCount} questions.`);
      }

      if (dto.questionTier) {
        if (dto.questionTier === 'mixed') {
          lines.push('- Tier requirement: mixed (include recall, application, and analysis).');
        } else {
          lines.push(`- Tier requirement: all questions must use tier \"${dto.questionTier}\".`);
        }
      }

      if (dto.questionFormat) {
        if (dto.questionFormat === 'mixed') {
          lines.push('- Format requirement: mixed (use multiple_choice, flashcard, and short_answer).');
        } else {
          lines.push(`- Format requirement: all questions must use format \"${dto.questionFormat}\".`);
        }
      }
    }

    if (dto.instructions?.trim()) {
      lines.push('', `Additional instructions: ${dto.instructions.trim()}`);
    }

    return lines.join('\n');
  }

  async findAllByUser(
    userId: string,
    options?: {
      page?: number;
      limit?: number;
      title?: string;
      subject?: string[];
      paginate?: boolean;
      timeOrder?: 'asc' | 'desc';
    },
  ) {
    const paginate = options?.paginate ?? false;
    const page = options?.page ?? 1;
    const limit = options?.limit ?? 6;
    const skip = (page - 1) * limit;
    const timeOrder = options?.timeOrder === 'asc' ? 'asc' : 'desc';

    const baseWhere: Prisma.GeneratedQuizWhereInput = {
      OR: [
        { userId },
        { saves: { some: { userId } } },
      ],
    };

    if (options?.title) {
      baseWhere.title = { contains: options.title, mode: 'insensitive' };
    }

    if (options?.subject?.length) {
      baseWhere.subject = { in: options.subject as any };
    }

    const where = baseWhere;

    const includeClause = {
      files: { select: { id: true, originalName: true, r2Key: true } },
      user: { select: { id: true, name: true, avatarUrl: true } },
      _count: { select: { likes: true } },
      likes: {
        where: { userId },
        select: { id: true },
        take: 1,
      },
      sessions: {
        where: { userId },
        select: { id: true, currentIndex: true, questionQueue: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' as const },
      },
      saves: {
        where: { userId },
        select: { id: true, createdAt: true },
        take: 1,
      },
    };

    const decks = await this.prisma.generatedQuiz.findMany({
      where,
      include: includeClause,
      orderBy: { createdAt: timeOrder },
      ...(paginate ? { skip, take: limit } : {}),
    });

    const ownerPublicDeckIds = decks
      .filter((deck) => deck.userId === userId && deck.isPublic)
      .map((deck) => deck.id);

    const likePreviewByDeckId = new Map<string, Array<{ id: string; name: string | null; avatarUrl: string | null }>>();

    if (ownerPublicDeckIds.length) {
      const previewLikes = await this.prisma.deckLike.findMany({
        where: {
          deckId: { in: ownerPublicDeckIds },
        },
        orderBy: { createdAt: 'desc' },
        select: {
          deckId: true,
          user: {
            select: {
              id: true,
              name: true,
              avatarUrl: true,
            },
          },
        },
      });

      for (const like of previewLikes) {
        const existing = likePreviewByDeckId.get(like.deckId) ?? [];
        if (existing.length >= 3) {
          continue;
        }

        existing.push({
          id: like.user.id,
          name: like.user.name,
          avatarUrl: this.toAvatarUrl(like.user.id, like.user.avatarUrl),
        });
        likePreviewByDeckId.set(like.deckId, existing);
      }
    }

    const total = paginate ? await this.prisma.generatedQuiz.count({ where }) : 0;

    const data = decks.map((deck: any) => {
      const deckWithPublicUrls = this.withDeckFilePublicUrls(deck);
      const isOwned = deck.userId === userId;
      const isSaved = (deck.saves?.length ?? 0) > 0;
      return {
        ...deckWithPublicUrls,
        files: isOwned ? deckWithPublicUrls.files : [],
        isOwned,
        isSaved,
        likeCount: isOwned && deck.isPublic ? deck._count?.likes ?? 0 : 0,
        likePreviewUsers: isOwned && deck.isPublic ? likePreviewByDeckId.get(deck.id) ?? [] : [],
        likedByMe: (deck.likes?.length ?? 0) > 0,
        savedAt: isSaved ? deck.saves[0].createdAt : null,
        _count: undefined,
        likes: undefined,
        saves: undefined,
        sessions: deck.sessions.map((session: any) => ({
          id: session.id,
          currentIndex: session.currentIndex,
          updatedAt: session.updatedAt,
          questionQueueLength: session.questionQueue.length,
        })),
      };
    });

    if (!paginate) {
      return data;
    }

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async searchPublicDecks(
    userId: string,
    options: {
      title?: string;
      subject?: string[];
      school?: string;
      page?: number;
      limit?: number;
      paginate?: boolean;
    },
  ) {
    const paginate = options.paginate ?? false;
    const page = options.page ?? 1;
    const limit = options.limit ?? 12;
    const skip = (page - 1) * limit;

    const where: Prisma.GeneratedQuizWhereInput = { isPublic: true };

    if (options.title) {
      where.title = { contains: options.title.trim(), mode: 'insensitive' };
    }

    if (options.subject?.length) {
      where.subject = { in: options.subject as any };
    }

    if (options.school) {
      where.user = {
        school: { contains: options.school.trim(), mode: 'insensitive' },
      };
    }

    const includeClause = {
      files: { select: { id: true, originalName: true, r2Key: true } },
      user: { select: { id: true, name: true, avatarUrl: true, school: true } },
      _count: { select: { likes: true } },
      likes: { where: { userId }, select: { id: true }, take: 1 },
      saves: { where: { userId }, select: { id: true }, take: 1 },
    };

    const [decks, total] = await Promise.all([
      this.prisma.generatedQuiz.findMany({
        where,
        include: includeClause,
        orderBy: { createdAt: 'desc' },
        skip: paginate ? skip : 0,
        take: paginate ? limit : 50,
      }),
      paginate ? this.prisma.generatedQuiz.count({ where }) : Promise.resolve(0),
    ]);

    const data = decks.map((deck: any) => ({
      ...this.withDeckFilePublicUrls(deck),
      files: [],
      likeCount: deck._count?.likes ?? 0,
      likedByMe: (deck.likes?.length ?? 0) > 0,
      savedByMe: (deck.saves?.length ?? 0) > 0,
      _count: undefined,
      likes: undefined,
      saves: undefined,
    }));

    if (!paginate) return data;

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findAllPublic(
    userId?: string,
    options?: {
      page?: number;
      limit?: number;
      title?: string;
      subject?: string[];
      paginate?: boolean;
      view?: 'trending' | 'newest' | 'following';
      timeOrder?: 'asc' | 'desc';
      filterUserId?: string;
    },
  ) {
    const paginate = options?.paginate ?? false;
    const page = options?.page ?? 1;
    const limit = options?.limit ?? 6;
    const skip = (page - 1) * limit;
    const view = options?.view ?? 'newest';
    const timeOrder = options?.timeOrder === 'asc' ? 'asc' : 'desc';

    if (view === 'following' && !userId) {
      return paginate
        ? { data: [], total: 0, page, limit, totalPages: 0 }
        : [];
    }

    const where: Prisma.GeneratedQuizWhereInput = { isPublic: true };

    if (options?.filterUserId) {
      where.userId = options.filterUserId;
    }

    if (options?.title) {
      where.title = { contains: options.title, mode: 'insensitive' };
    }

    if (options?.subject?.length) {
      where.subject = { in: options.subject as any };
    }

    if (view === 'following') {
      where.user = {
        followers: {
          some: { followerId: userId },
        },
      };
    }

    const orderBy: Prisma.GeneratedQuizOrderByWithRelationInput[] = view === 'trending'
      ? [{ likes: { _count: 'desc' } }, { createdAt: timeOrder }]
      : [{ createdAt: timeOrder }];

    const includeClause = {
      files: { select: { id: true, originalName: true, r2Key: true } },
      user: { select: { id: true, name: true, avatarUrl: true } },
      _count: { select: { likes: true } },
      ...(userId
        ? {
            sessions: {
              where: { userId },
              select: { id: true, currentIndex: true, questionQueue: true, updatedAt: true },
              orderBy: { updatedAt: 'desc' as const },
            },
            likes: {
              where: { userId },
              select: { id: true },
              take: 1,
            },
            saves: {
              where: { userId },
              select: { id: true },
              take: 1,
            },
          }
        : {}),
    };

    const decks = await this.prisma.generatedQuiz.findMany({
      where,
      include: includeClause,
      orderBy,
      ...(paginate ? { skip, take: limit } : {}),
    });

    const total = paginate ? await this.prisma.generatedQuiz.count({ where }) : 0;

    const data = decks.map((deck: any) => {
      const deckWithPublicUrls = this.withDeckFilePublicUrls(deck);
      return {
        ...deckWithPublicUrls,
        files: [],
        likeCount: deck._count?.likes ?? 0,
        likedByMe: userId ? (deck.likes?.length ?? 0) > 0 : false,
        savedByMe: userId ? (deck.saves?.length ?? 0) > 0 : false,
        _count: undefined,
        likes: undefined,
        saves: undefined,
        isOwned: deck.userId === userId,
      };
    });

    if (!paginate) {
      return data;
    }

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOne(id: string) {
    const deck = await this.prisma.generatedQuiz.findUnique({
      where: { id },
      include: {
        files: { select: { id: true, originalName: true, r2Key: true } },
        questions: { orderBy: { orderIndex: 'asc' } },
      },
    });

    return deck ? this.withDeckFilePublicUrls(deck) : deck;
  }

  async getDeckLikesForOwner(userId: string, id: string) {
    const deck = await this.prisma.generatedQuiz.findFirst({
      where: { id, userId, isPublic: true },
      select: {
        id: true,
        title: true,
        _count: { select: { likes: true } },
        likes: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            createdAt: true,
            user: {
              select: {
                id: true,
                name: true,
                avatarUrl: true,
              },
            },
          },
        },
      },
    });

    if (!deck) {
      throw new NotFoundException('Deck not found');
    }

    return {
      deckId: deck.id,
      title: deck.title,
      likeCount: deck._count.likes,
      likedUsers: deck.likes.map((like) => ({
        id: like.user.id,
        name: like.user.name,
        avatarUrl: this.toAvatarUrl(like.user.id, like.user.avatarUrl),
        likedAt: like.createdAt,
      })),
    };
  }

  async togglePublic(userId: string, id: string) {
    const deck = await this.prisma.generatedQuiz.findFirst({
      where: { id, userId },
    });

    if (!deck) {
      throw new NotFoundException('Deck not found');
    }

    const updated = await this.prisma.generatedQuiz.update({
      where: { id },
      data: { isPublic: !deck.isPublic },
    });

    return { id: updated.id, isPublic: updated.isPublic };
  }

  async updateDeckTitle(userId: string, id: string, title: string) {
    if (!title || !title.trim()) {
      throw new BadRequestException('Title cannot be empty');
    }

    const deck = await this.prisma.generatedQuiz.findFirst({
      where: { id, userId },
    });

    if (!deck) {
      throw new NotFoundException('Deck not found');
    }

    const updated = await this.prisma.generatedQuiz.update({
      where: { id },
      data: { title: title.trim() },
      select: { id: true, title: true },
    });

    return updated;
  }

   async handleLikeAction(userId: string, id: string) {
    const deck = await this.prisma.generatedQuiz.findFirst({
      where: { id, isPublic: true },
    });

    if (!deck) {
      throw new NotFoundException('Deck not found');
    }

    const existingLike = await this.prisma.deckLike.findUnique({
      where: { userId_deckId: { userId, deckId: id } },
    });

    if (existingLike) {
      await this.prisma.deckLike.delete({
        where: { id: existingLike.id },
      });
      return { liked: false };
    }

    await this.prisma.deckLike.create({
      data: { userId, deckId: id },
    });

    return { liked: true };
  }

  async handleSave(userId: string, id: string) {
    const existing = await this.prisma.deckSave.findUnique({
      where: { userId_deckId: { userId, deckId: id } },
    });

    if (existing) {
      await this.prisma.deckSave.delete({ where: { id: existing.id } });
      const saveCount = await this.prisma.deckSave.count({ where: { deckId: id } });
      return { saved: false, saveCount };
    }

    const deck = await this.prisma.generatedQuiz.findFirst({
      where: { id, isPublic: true },
      select: { id: true, userId: true },
    });
    if (!deck) throw new NotFoundException('Deck not found');
    if (deck.userId === userId) {
      throw new BadRequestException('You cannot save your own deck');
    }

    await this.prisma.deckSave.create({ data: { userId, deckId: id } });
    const saveCount = await this.prisma.deckSave.count({ where: { deckId: id } });
    return { saved: true, saveCount };
  }

  async removeByUser(userId: string, quizId: string) {
    const result = await this.prisma.generatedQuiz.deleteMany({
      where: { id: quizId, userId },
    });

    if (result.count === 0) {
      throw new NotFoundException('Deck not found');
    }

    return { success: true };
  }



  async startOrResumeSession(userId: string, quizId: string, options?: { replay?: boolean }) {
    const quiz = await this.prisma.generatedQuiz.findFirst({
      where: this.buildDeckAccessWhere(userId, quizId),
      include: { questions: { orderBy: { orderIndex: 'asc' } } },
    });

    if (!quiz) {
      throw new NotFoundException('Deck not found');
    }

    const questionQueue = quiz.questions.map((q) => q.id);

    let session = await this.prisma.studySession.findUnique({
      where: { userId_quizId: { userId, quizId } },
    });

    if (!session) {
      session = await this.prisma.studySession.create({
        data: {
          userId,
          quizId,
          questionQueue,
          currentIndex: 0,
        },
      });
      await this.ensureSessionQuestionProgress(session.id, questionQueue);
    } else if (options?.replay) {
      // Replay resets queue order and index, but keeps accumulated progress rows.
      session = await this.prisma.studySession.update({
        where: { id: session.id },
        data: {
          questionQueue,
          currentIndex: 0,
        },
      });
      await this.ensureSessionQuestionProgress(session.id, questionQueue);
    } else if (session.questionQueue.length === 0 && questionQueue.length > 0) {
      session = await this.prisma.studySession.update({
        where: { id: session.id },
        data: {
          questionQueue,
          currentIndex: 0,
        },
      });
      await this.ensureSessionQuestionProgress(session.id, questionQueue);
    } else {
      await this.ensureSessionQuestionProgress(session.id, session.questionQueue);
    }

    return this.getSessionByQuizId(userId, quizId);
  }
  
  async getSessionByQuizId(userId: string, quizId: string) {
    const session = await this.prisma.studySession.findFirst({
      where: { userId, quizId },
      include: {
        quiz: {
          select: {
            title: true,
            subject: true,
          },
        },
      },
    });

    if (!session) {
      throw new NotFoundException('Study session not found');
    }

    const totalQuestions = session.questionQueue.length;
    const completedQuestions = Math.min(session.currentIndex, totalQuestions);
    const completionPercent = totalQuestions
      ? Math.round((completedQuestions / totalQuestions) * 100)
      : 0;

    return {
      id: session.id,
      quizId: session.quizId,
      title: session.quiz.title,
      subject: session.quiz.subject,
      questionQueue: session.questionQueue,
      currentIndex: session.currentIndex,
      totalQuestions,
      completedQuestions,
      completionPercent,
      isCompleted: session.currentIndex >= totalQuestions,
    };
  }

  async getQuestionBatch(userId: string, sessionId: string, offset = 0, limit?: number) {
    const safeOffset = Math.max(0, offset);
    const requestedLimit = typeof limit === 'number' ? limit : this.defaultBatchSize;
    const safeLimit = Math.max(1, Math.min(this.maxBatchSize, requestedLimit));

    const session = await this.prisma.studySession.findFirst({
      where: { id: sessionId, userId },
      include: {
        questionProgress: true,
        quiz: {
          include: {
            questions: { orderBy: { orderIndex: 'asc' } },
          },
        },
      },
    });

    if (!session) {
      throw new NotFoundException('Study session not found');
    }

    const questionIds = session.questionQueue.slice(safeOffset, safeOffset + safeLimit);
    const batch = questionIds
      .map((questionId) => {
        const question = session.quiz.questions.find((item) => item.id === questionId);
        if (!question) {
          return null;
        }

        const progress = session.questionProgress.find((item) => item.questionId === questionId);
        return {
          ...question,
          timesAnswered: progress?.timesAnswered ?? 0,
          timesCorrect: progress?.timesCorrect ?? 0,
          streak: progress?.streak ?? 0,
          lastReviewed: progress?.lastReviewed ?? null,
        };
      })
      .filter(Boolean);

    return { batch };
  }

  private async scoreAndPersistAnswer(
    session: StudySessionWithQuiz,
    answerItem: {
      questionId?: string;
      answer?: string;
      correct?: boolean;
      attemptId?: string;
      clientTimestamp?: string;
    },
    isCorrectOverride?: boolean,
  ) {
    if (!answerItem.questionId) {
      return;
    }

    const question = session.quiz.questions.find((item) => item.id === answerItem.questionId);
    if (!question) {
      return;
    }
    
    // For flashcards, the client determines correctness, so we trust the client-provided value. For other formats, we determine correctness by comparing normalized strings.
    const normalize = (value?: string) => (value || '').trim().toLowerCase();
    const isCorrect = typeof isCorrectOverride === 'boolean'
      ? isCorrectOverride
      : question.format === 'flashcard'
        ? Boolean(answerItem.correct)
        : normalize(answerItem.answer) === normalize(question.correctAnswer);

    const progress = session.questionProgress.find((item) => item.questionId === question.id);
    if (!progress) {
      await this.ensureSessionQuestionProgress(session.id, [question.id]);
    }

    await this.prisma.studySessionQuestionProgress.update({
      where: {
        sessionId_questionId: {
          sessionId: session.id,
          questionId: question.id,
        },
      },
      data: {
        timesAnswered: (progress?.timesAnswered ?? 0) + 1,
        timesCorrect: (progress?.timesCorrect ?? 0) + (isCorrect ? 1 : 0),
        streak: isCorrect ? (progress?.streak ?? 0) + 1 : 0,
        lastReviewed: new Date(),
      },
    });

    return { isCorrect };
  }

  private async evaluateShortAnswerWithStoredContext(
    session: StudySessionWithQuizFiles,
    question: { question: string; correctAnswer: string; explanation?: string | null; gradingContext?: string | null; topic?: string | null },
    userAnswer: string,
  ) {
    const prompt = [
      'You are grading a student short-answer response for a study deck.',
      'Use the stored deck grading context and question grading context as the primary source-aware guidance.',
      'Also use your own reasoning and subject knowledge when the student answer is conceptually correct, paraphrased, or more concise than the canonical answer.',
      'Do not require exact wording.',
      `A score of ${this.shortAnswerPassingScore} or above counts as correct.`,
      'Be strict about factual contradictions, but tolerant of equivalent phrasing and partial wording when the core idea is correct.',
      '',
      `Deck grading context: ${this.buildFallbackDeckGradingContext([], session.quiz.gradingContext)}`,
      `Question: ${question.question}`,
      `Canonical answer: ${question.correctAnswer}`,
      `Question grading context: ${this.buildFallbackQuestionGradingContext(question)}`,
      `Reference explanation: ${this.buildFallbackExplanation(question)}`,
      `Student answer: ${userAnswer}`,
      '',
      'Return JSON only with:',
      '- score: number from 0 to 100',
      '- isCorrect: boolean consistent with the score threshold',
      '- feedback: concise explanation of why the answer is correct or incorrect',
    ].join('\n');

    const response = await this.gemini.generateContent({
      contents: [{ parts: [{ text: prompt }] }],
      config: {
        responseMimeType: 'application/json',
        responseJsonSchema: zodToJsonSchema(shortAnswerEvaluationSchema as any),
      },
    });

    const parsed = shortAnswerEvaluationSchema.parse(JSON.parse(response.text));
    const score = Math.max(0, Math.min(100, Math.round(parsed.score)));

    return {
      score,
      threshold: this.shortAnswerPassingScore,
      isCorrect: score >= this.shortAnswerPassingScore,
      feedback: parsed.feedback.trim(),
    };
  }

  private async evaluateShortAnswerWithSourceFiles(
    session: StudySessionWithQuizFiles,
    question: { question: string; correctAnswer: string; explanation?: string | null; gradingContext?: string | null; topic?: string | null },
    userAnswer: string,
  ) {
    const tempPaths: string[] = [];
    const uploadedFiles: Array<{ name: string; uri: string; mimeType: string }> = [];

    try {
      for (const file of session.quiz.files) {
        const { buffer, mimeType, originalName } = await this.filesService.getFileBuffer(file.id);
        const tempPath = path.join(os.tmpdir(), `${Date.now()}-${file.id}-${originalName}`);
        fs.writeFileSync(tempPath, buffer);
        tempPaths.push(tempPath);

        const uploadedFile = await this.gemini.uploadFile({
          file: tempPath,
          config: { mimeType, displayName: originalName },
        });

        uploadedFiles.push({
          name: uploadedFile.name,
          uri: uploadedFile.uri,
          mimeType,
        });
      }

      const prompt = [
        'You are grading a student short-answer response for a study deck.',
        'Use the attached source files as primary context when they are relevant.',
        'Also use your own reasoning and subject knowledge when the student answer is conceptually correct, paraphrased, or more concise than the canonical answer.',
        'Do not require exact wording.',
        `A score of ${this.shortAnswerPassingScore} or above counts as correct.`,
        'Be strict about factual contradictions, but tolerant of equivalent phrasing and partial wording when the core idea is correct.',
        '',
        `Deck grading context: ${this.buildFallbackDeckGradingContext([], session.quiz.gradingContext)}`,
        `Question: ${question.question}`,
        `Canonical answer: ${question.correctAnswer}`,
        `Question grading context: ${this.buildFallbackQuestionGradingContext(question)}`,
        `Reference explanation: ${this.buildFallbackExplanation(question)}`,
        `Student answer: ${userAnswer}`,
        '',
        'Return JSON only with:',
        '- score: number from 0 to 100',
        '- isCorrect: boolean consistent with the score threshold',
        '- feedback: concise explanation of why the answer is correct or incorrect',
      ].join('\n');

      const response = await this.gemini.generateContent({
        contents: [
          {
            parts: [
              ...uploadedFiles.map((file) => ({
                fileData: {
                  mimeType: file.mimeType,
                  fileUri: file.uri,
                },
              })),
              { text: prompt },
            ],
          },
        ],
        config: {
          responseMimeType: 'application/json',
          responseJsonSchema: zodToJsonSchema(shortAnswerEvaluationSchema as any),
        },
      });

      const parsed = shortAnswerEvaluationSchema.parse(JSON.parse(response.text));
      const score = Math.max(0, Math.min(100, Math.round(parsed.score)));

      return {
        score,
        threshold: this.shortAnswerPassingScore,
        isCorrect: score >= this.shortAnswerPassingScore,
        feedback: parsed.feedback.trim(),
      };
    } finally {
      for (const tempPath of tempPaths) {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      }

      for (const file of uploadedFiles) {
        await this.gemini.deleteFile({ name: file.name }).catch(() => {});
      }
    }
  }

  private async evaluateShortAnswer(
    session: StudySessionWithQuizFiles,
    question: { question: string; correctAnswer: string; explanation?: string | null; gradingContext?: string | null; topic?: string | null },
    userAnswer: string,
  ) {
    const hasStoredContext = Boolean(
      String(session.quiz.gradingContext || '').trim() || String(question.gradingContext || '').trim(),
    );

    if (hasStoredContext) {
      return this.evaluateShortAnswerWithStoredContext(session, question, userAnswer);
    }

    return this.evaluateShortAnswerWithSourceFiles(session, question, userAnswer);
  }

  private pruneProcessedAttempts() {
    const cutoff = Date.now() - this.processedAttemptTtlMs;
    for (const [key, value] of this.processedAttempts.entries()) {
      if (value < cutoff) {
        this.processedAttempts.delete(key);
      }
    }
  }

  private buildAttemptKey(userId: string, sessionId: string, attemptId?: string) {
    if (!attemptId) {
      return null;
    }

    return `${userId}:${sessionId}:${attemptId}`;
  }

  private hasProcessedAttempt(key: string) {
    this.pruneProcessedAttempts();
    return this.processedAttempts.has(key);
  }

  private markProcessedAttempt(key: string) {
    this.pruneProcessedAttempts();
    this.processedAttempts.set(key, Date.now());
  }

  async submitAnswer(userId: string, sessionId: string, dto: SubmitAnswerDto) {
    const session = await this.prisma.studySession.findFirst({
      where: { id: sessionId, userId },
      include: {
        questionProgress: true,
        quiz: {
          include: {
            questions: { orderBy: { orderIndex: 'asc' } },
            files: true,
          },
        },
      },
    }) as StudySessionWithQuizFiles | null;

    if (!session) {
      throw new NotFoundException('Study session not found');
    }

    if (!dto.questionId) {
      throw new BadRequestException('questionId is required');
    }

    const attemptKey = this.buildAttemptKey(userId, sessionId, dto.attemptId);
    if (attemptKey && this.hasProcessedAttempt(attemptKey)) {
      return { success: true };
    }

    const currentQuestionId = session.questionQueue[session.currentIndex];
    if (currentQuestionId && dto.questionId !== currentQuestionId) {
      throw new ForbiddenException('Answer does not match current card');
    }

    const currentQuestion = session.quiz.questions.find((item) => item.id === dto.questionId);
    if (!currentQuestion) {
      throw new NotFoundException('Question not found in this study session');
    }
    
    let shortAnswerEvaluation:
      | { score: number; threshold: number; isCorrect: boolean; feedback: string }
      | null = null;

    if (currentQuestion.format === 'short_answer') {
      const submittedAnswer = String(dto.answer || '').trim();
      if (!submittedAnswer) {
        throw new BadRequestException('answer is required for short answer questions');
      }

      shortAnswerEvaluation = await this.evaluateShortAnswer(session, currentQuestion, submittedAnswer);
    }

    //if shortAnswerevaluation is not null, it contains the isCorrect value determined by the LLM. For other question formats,

    const persistedResult = await this.scoreAndPersistAnswer(
      session,
      dto,
      shortAnswerEvaluation?.isCorrect,
    );
    if (attemptKey) {
      this.markProcessedAttempt(attemptKey);
    }

    const nextIndex = Math.min(
      session.currentIndex + 1,
      session.questionQueue.length,
    );
    await this.prisma.studySession.update({
      where: { id: session.id },
      data: { currentIndex: nextIndex },
    });

    return {
      success: true,
      isCorrect: persistedResult.isCorrect,
      feedback: shortAnswerEvaluation?.feedback,
      score: shortAnswerEvaluation?.score,
      threshold: shortAnswerEvaluation?.threshold,
    };
  }

  async shuffleRemainingQuestions(userId: string, sessionId: string) {
    const session = await this.prisma.studySession.findFirst({
      where: { id: sessionId, userId },
      include: {
        questionProgress: true,
        quiz: {
          include: {
            questions: { orderBy: { orderIndex: 'asc' } },
          },
        },
      },
    });

    if (!session) {
      throw new NotFoundException('Study session not found');
    }

    const answered = session.questionQueue.slice(0, session.currentIndex);
    const remaining = [...session.questionQueue.slice(session.currentIndex)];

    for (let i = remaining.length - 1; i > 0; i -= 1) {
      const randomIndex = Math.floor(Math.random() * (i + 1));
      [remaining[i], remaining[randomIndex]] = [remaining[randomIndex], remaining[i]];
    }

    const questionQueue = [...answered, ...remaining];

    const updatedSession = await this.prisma.studySession.update({
      where: { id: session.id },
      data: { questionQueue },
      include: {
        questionProgress: true,
        quiz: {
          include: {
            questions: { orderBy: { orderIndex: 'asc' } },
          },
        },
      },
    });

    return this.buildSessionPayload(updatedSession);
  }

  private buildSessionPayload(session: StudySessionWithQuiz) {
    const totalQuestions = session.questionQueue.length;
    const completedQuestions = Math.min(session.currentIndex, totalQuestions);
    const completionPercent = totalQuestions
      ? Math.round((completedQuestions / totalQuestions) * 100)
      : 0;

    const currentQuestionId = session.questionQueue[session.currentIndex] || null;
    const currentQuestion = currentQuestionId
      ? session.quiz.questions.find((q) => q.id === currentQuestionId) || null
      : null;
    const currentQuestionProgress = currentQuestionId
      ? session.questionProgress.find((progress) => progress.questionId === currentQuestionId) || null
      : null;

    return {
      id: session.id,
      quizId: session.quizId,
      title: session.quiz.title,
      subject: session.quiz.subject,
      questionQueue: session.questionQueue,
      currentIndex: session.currentIndex,
      totalQuestions,
      completedQuestions,
      completionPercent,
      isCompleted: session.currentIndex >= totalQuestions,
      currentQuestion: currentQuestion
        ? {
            ...currentQuestion,
            timesAnswered: currentQuestionProgress?.timesAnswered ?? 0,
            timesCorrect: currentQuestionProgress?.timesCorrect ?? 0,
            streak: currentQuestionProgress?.streak ?? 0,
            lastReviewed: currentQuestionProgress?.lastReviewed ?? null,
          }
        : null,
    };
  }

  async getDeckAnalytics(userId: string, quizId: string) {
    const quiz = await this.prisma.generatedQuiz.findFirst({
      where: this.buildDeckAccessWhere(userId, quizId),
      include: {
        questions: { orderBy: { orderIndex: 'asc' } },
        sessions: {
          where: { userId },
          include: {
            questionProgress: true,
          },
          orderBy: { updatedAt: 'desc' },
          take: 1,
        },
      },
    });

    if (!quiz) {
      throw new NotFoundException('Deck not found');
    }

    const session = quiz.sessions[0] || null;
    const progressMap = new Map(
      (session?.questionProgress || []).map((p) => [p.questionId, p]),
    );

    // Per-question breakdown
    const questions = quiz.questions.map((q) => {
      const progress = progressMap.get(q.id);
      return {
        id: q.id,
        question: q.question,
        tier: q.tier,
        format: q.format,
        topic: q.topic,
        timesAnswered: progress?.timesAnswered ?? 0,
        timesCorrect: progress?.timesCorrect ?? 0,
        streak: progress?.streak ?? 0,
        lastReviewed: progress?.lastReviewed ?? null,
      };
    });

    // Aggregate by tier
    const tierStats = this.aggregateBy(questions, 'tier');
    // Aggregate by format
    const formatStats = this.aggregateBy(questions, 'format');
    // Aggregate by topic
    const topicStats = this.aggregateBy(
      questions.filter((q) => q.topic),
      'topic',
    );

    const totalAnswered = questions.reduce((s, q) => s + q.timesAnswered, 0);
    const totalCorrect = questions.reduce((s, q) => s + q.timesCorrect, 0);

    return {
      deckTitle: quiz.title,
      subject: quiz.subject,
      rigorIndex: quiz.rigorIndex,
      totalQuestions: questions.length,
      totalAnswered,
      totalCorrect,
      overallAccuracy: totalAnswered > 0 ? Math.round((totalCorrect / totalAnswered) * 100) : 0,
      sessionComplete: session ? session.currentIndex >= session.questionQueue.length : false,
      tierStats,
      formatStats,
      topicStats,
      questions,
    };
  }

  private aggregateBy(
    questions: { timesAnswered: number; timesCorrect: number; [key: string]: any }[],
    key: string,
  ) {
    const groups: Record<string, { total: number; answered: number; correct: number }> = {};
    for (const q of questions) {
      const value = q[key] as string;
      if (!groups[value]) {
        groups[value] = { total: 0, answered: 0, correct: 0 };
      }
      groups[value].total += 1;
      groups[value].answered += q.timesAnswered;
      groups[value].correct += q.timesCorrect;
    }
    return Object.entries(groups).map(([name, stats]) => ({
      name,
      ...stats,
      accuracy: stats.answered > 0 ? Math.round((stats.correct / stats.answered) * 100) : 0,
    }));
  }

  async clearTutorChatHistory(userId: string, quizId: string) {
    const conversation = await this.prisma.tutorConversation.findUnique({
      where: { userId_quizId: { userId, quizId } },
    });

    if (!conversation) return { success: true };

    // Cascade delete handles the messages automatically
    await this.prisma.tutorConversation.delete({
      where: { id: conversation.id },
    });

    return { success: true };
  }

  async getTutorChatHistory(userId: string, quizId: string, cursor?: string, limit: number = 20) {
    const conversation = await this.prisma.tutorConversation.findUnique({
      where: {
        userId_quizId: { userId, quizId },
      },
    });

    if (!conversation) {
      return { messages: [], nextCursor: null };
    }

    // Fetch messages from newest to oldest to easily find the next page
    const messages = await this.prisma.tutorMessage.findMany({
      where: { conversationId: conversation.id },
      take: limit + 1, // Fetch one extra to check if there are more pages
      skip: cursor ? 1 : 0, // Skip the cursor message itself
      ...(cursor && { cursor: { id: cursor } }),
      orderBy: { createdAt: 'desc' },
      select: { id: true, role: true, text: true, createdAt: true },
    });

    let nextCursor = null;
    if (messages.length > limit) {
      const nextItem = messages.pop(); // Remove the extra item
      nextCursor = nextItem.id; // The ID to send next time to fetch older messages
    }

    // Reverse to return them in standard chronological order (oldest -> newest)
    return { 
      messages: messages.reverse(), 
      nextCursor 
    };
  }

  async tutorChat(
    userId: string,
    quizId: string,
    userText: string, // <-- Changed from array to a single text string
  ) {
    const tutorChatCreditCost = calculateCreditsForUnits(CreditCostType.TUTOR_CHAT_MESSAGE, 1);
    const creditSummary = await this.billing.getCreditSummary(userId);
    const hasUnlimitedTutorMessages = creditSummary.plan === PlanType.PRO;

    if (!hasUnlimitedTutorMessages && creditSummary.remainingCredits < tutorChatCreditCost) {
       return {
          status: 'credits_needed',
          requiredCredits: tutorChatCreditCost,
          remainingCredits: creditSummary.remainingCredits,
          monthlyCredits: creditSummary.monthlyCredits,
        };
    }

    // 1. Find or create the conversation thread in the DB

    const conversation = await this.prisma.tutorConversation.upsert({
      where: { userId_quizId: { userId, quizId } },
      create: { userId, quizId },
      update: {},
    });

    // 2. Save the new user message to the DB
    await this.prisma.tutorMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'user',
        text: userText,
      },
    });

    const generationLanguage = await this.getUserPreferredLanguage(userId);

    // 3. Fetch analytics (Your existing logic)
    const analytics = await this.getDeckAnalytics(userId, quizId);

    // 4. Build system instruction (Your existing logic)
    const systemInstruction = `You are a friendly, encouraging AI study tutor. The student just reviewed their quiz analytics and you are here to help them understand their performance and guide them on what to focus on next.

Here is the student's analytics data for the deck "${analytics.deckTitle}":
- Subject: ${analytics.subject || 'General'}
- Total Questions: ${analytics.totalQuestions}
- Total Attempts: ${analytics.totalAnswered}
- Overall Accuracy: ${analytics.overallAccuracy}%
- Session complete: ${analytics.sessionComplete}

Tier breakdown:
${analytics.tierStats.map((t) => `  ${t.name}: ${t.accuracy}% accuracy (${t.correct}/${t.answered} correct, ${t.total} questions)`).join('\n')}

Format breakdown:
${analytics.formatStats.map((f) => `  ${f.name}: ${f.accuracy}% accuracy (${f.correct}/${f.answered} correct)`).join('\n')}

Topic breakdown:
${analytics.topicStats.map((t) => `  ${t.name}: ${t.accuracy}% accuracy (${t.correct}/${t.answered} correct)`).join('\n')}

Questions the student struggled with (accuracy < 60%):
${analytics.questions.filter((q) => q.timesAnswered > 0 && (q.timesCorrect / q.timesAnswered) < 0.6).map((q) => `  - "${q.question}" (${q.tier}, ${Math.round((q.timesCorrect / q.timesAnswered) * 100)}% accuracy)`).join('\n') || '  None — great job!'}

Guidelines:
- Language requirement: write all AI tutor interactions entirely in ${APP_LANGUAGE_LABELS[generationLanguage]}, including greetings, explanations, examples, hints, feedback, follow-up questions, learning summaries, corrections, and recommendations. Maintain a natural conversational tone in the selected language. Do not mix languages or translate content unless the user explicitly requests it.
- Be warm, supportive, and use a conversational tutor tone
- Default to short answers that feel like natural back-and-forth, not a report
- Start with the minimum helpful answer first; usually 2-5 sentences is enough
- Use at most 1-2 relevant stats unless the user explicitly asks for a deeper breakdown
- Do not dump all analytics categories at once; pick the single most relevant insight or next step
- Only give a detailed breakdown when the user asks for more detail, asks for analysis, or the situation truly requires it
- Translate stats into plain language and focus on what the student should do next
- If this is the first message, introduce yourself briefly, give a quick read on how they did, mention one strength and one improvement area, then stop
- When helpful, end with one simple follow-up question or one concrete next step
- Avoid long lists, dense summaries, or reciting every metric unless requested
- If they ask a narrow question, answer only that question and keep the scope tight
- You can use emoji sparingly for friendliness`;

    // 5. Fetch chat history from the DB (Limits to last 20 messages for context size)
    const recentMessages = await this.prisma.tutorMessage.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'desc' },
      take: 20, 
    });

    // 6. Map DB history to Gemini format (Your existing mapping)
    const contents = recentMessages.reverse().map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user', // Adjusted to match your DB enum -> Gemini
      parts: [{ text: m.text }],
    }));

    // (Removed the hardcoded "Hi!" trigger here because the DB will always 
    // have at least the user's initial message saved in step 2)

    // 7. Call Gemini (Your existing logic)
    const response = await this.gemini.generateContent({
      contents,
      config: {
        systemInstruction,
      },
    });

    const aiReplyText = String(response.text || '').trim();

    if (!aiReplyText) {
      throw new InternalServerErrorException('Tutor AI returned an empty response.');
    }
    
    // 8. Save the AI's response back to the DB
    await this.prisma.tutorMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'assistant',
        text: aiReplyText,
      },
    });

    if (!hasUnlimitedTutorMessages) {
      await this.billing.consumeCredits(userId, tutorChatCreditCost, 'Tutor chat');
    }

    return { reply: aiReplyText };
    }}
