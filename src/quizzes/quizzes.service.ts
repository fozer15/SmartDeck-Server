import { Injectable, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FilesService } from '../files/files.service';
import { EnvService } from '../env/env.service';
import { GoogleGenAI } from '@google/genai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';
import { quizResponseSchema } from './schemas/quiz.schema';
import { GenerateQuizDto } from './dto/generate-quiz.dto';
import { SubmitAnswerDto } from './dto/submit-answer.dto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PDFDocument } from 'pdf-lib';

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

@Injectable()
export class QuizzesService {
  private genAI: GoogleGenAI;
  private r2PublicUrl: string;
  private readonly processedAttempts = new Map<string, number>();
  private readonly processedAttemptTtlMs = 30 * 60 * 1000;
  private readonly defaultBatchSize = 5;
  private readonly maxBatchSize = 50;
  private readonly shortAnswerPassingScore = 70;

  private readonly systemPrompt = `You are an expert educational content creator. Analyze the provided PDF and generate quiz questions categorized by Bloom's Taxonomy cognitive tiers:

- Tier 1 "recall": Basic memorization (e.g. "What year was X founded?", "What is the formula for Y?")
- Tier 2 "application": Using a concept in a straightforward scenario (e.g. "Calculate the velocity using the formula")
- Tier 3 "analysis": Connecting multiple concepts or evaluating tradeoffs (e.g. "Why did approach A fail compared to approach B?")

Also compute a Rigor Index (0-100): a weighted score where recall questions contribute 30 points worth of weight, application 60, and analysis 100. Average across all questions. A recall-only quiz scores ~30, a balanced mix ~60, heavy analysis/application pushes toward 85-100.

Guidelines:
- Structured user preferences are authoritative. If question count, tier preference, or format preference is provided, follow it exactly.
- If no user preference is provided, default to 8 questions with a balanced mix of tiers and formats.
- Use one of these JSON format values for each question: multiple_choice, flashcard, short_answer
- For multiple_choice only: include exactly 4 options
- For flashcard and short_answer: do not include options
- Provide a clear explanation for each answer
- Provide a deck-level gradingContext that summarizes the key concepts, acceptable paraphrases, and what matters most when grading answers for this deck
- Provide a gradingContext for each question that captures the specific facts or reasoning needed to grade that question without re-reading the original source`;

  constructor(
    private prisma: PrismaService,
    private filesService: FilesService,
    private env: EnvService,
  ) {
    this.genAI = new GoogleGenAI({ apiKey: env.geminiApiKey });
    this.r2PublicUrl = env.r2PublicUrl;
  }

  private toPublicUrl(value?: string | null) {
    if (!value) {
      return null;
    }

    if (/^https?:\/\//i.test(value)) {
      return value;
    }

    const encodedKey = value
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');

    return this.r2PublicUrl ? `${this.r2PublicUrl}/${encodedKey}` : encodedKey;
  }

  private withDeckFilePublicUrls<T extends { files?: Array<{ r2Key?: string | null }> }>(deck: T): T {
    const files = Array.isArray(deck.files)
      ? deck.files.map((file) => ({
          ...file,
          publicUrl: this.toPublicUrl(file.r2Key),
        }))
      : deck.files;

    const user =
      deck && typeof deck === 'object' && 'user' in deck && deck.user && typeof deck.user === 'object'
        ? {
            ...(deck.user as Record<string, unknown>),
            avatarUrl: this.toPublicUrl((deck.user as { avatarUrl?: string | null }).avatarUrl),
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

  async generate(userId: string, dto: GenerateQuizDto) {
    if (dto.audioFileId) {
      return this.generateFromAudio(userId, dto);
    }

    if (!dto.fileIds || dto.fileIds.length === 0) {
      throw new BadRequestException('Either fileIds or audioFileId is required');
    }

    const pageSelectionsByFileId = this.normalizePageSelections(dto.fileIds, dto.pageSelections);

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

        const uploadedFile = await this.genAI.files.upload({
          file: tempPath,
          config: { mimeType, displayName },
        });
        uploadedFiles.push({
          name: uploadedFile.name,
          uri: uploadedFile.uri,
          mimeType,
        });
      }

      const prompt = this.buildPrompt(dto);

      // Generate quiz from all files
      const response = await this.genAI.models.generateContent({
        model: 'gemini-3.1-flash-lite-preview',
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
        await this.genAI.files.delete({ name: uploadedFile.name }).catch(() => {});
      }
    }
  }

  private async generateFromAudio(userId: string, dto: GenerateQuizDto) {
    const { buffer, mimeType, originalName } = await this.filesService.getFileBuffer(dto.audioFileId);
    const tempPath = path.join(os.tmpdir(), `${Date.now()}-${originalName}`);
    let uploadedFileName: string | null = null;

    try {
      fs.writeFileSync(tempPath, buffer);

      // Upload audio to Gemini File API
      const uploadedFile = await this.genAI.files.upload({
        file: tempPath,
        config: { mimeType, displayName: originalName },
      });
      uploadedFileName = uploadedFile.name;

      // Step 1: Transcribe the audio using Gemini
      const transcriptionResponse = await this.genAI.models.generateContent({
        model: 'gemini-3.1-flash-lite-preview',
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
      const prompt = this.buildPrompt(dto);
      const quizPrompt = `The following is a transcript from an audio recording. Use it as the source material to generate quiz questions.\n\n--- TRANSCRIPT START ---\n${transcript}\n--- TRANSCRIPT END ---\n\n${prompt}`;

      const quizResponse = await this.genAI.models.generateContent({
        model: 'gemini-3.1-flash-lite-preview',
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
        await this.genAI.files.delete({ name: uploadedFileName }).catch(() => {});
      }
    }
  }

  private buildPrompt(dto: GenerateQuizDto) {
    const lines = [this.systemPrompt];

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
    options?: { page?: number; limit?: number; title?: string; subject?: string[]; paginate?: boolean },
  ) {
    const paginate = options?.paginate ?? false;
    const page = options?.page ?? 1;
    const limit = options?.limit ?? 6;
    const skip = (page - 1) * limit;

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
      orderBy: { createdAt: 'desc' },
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
          avatarUrl: this.toPublicUrl(like.user.avatarUrl),
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

  async findAllPublic(
    userId?: string,
    options?: { page?: number; limit?: number; title?: string; subject?: string[]; paginate?: boolean },
  ) {
    const paginate = options?.paginate ?? false;
    const page = options?.page ?? 1;
    const limit = options?.limit ?? 6;
    const skip = (page - 1) * limit;

    const where: Prisma.GeneratedQuizWhereInput = { isPublic: true };

    if (options?.title) {
      where.title = { contains: options.title, mode: 'insensitive' };
    }

    if (options?.subject?.length) {
      where.subject = { in: options.subject as any };
    }

    const includeClause = {
      files: { select: { id: true, originalName: true, r2Key: true } },
      user: { select: { id: true, name: true, avatarUrl: true } },
      _count: { select: { likes: true } },
      ...(userId
        ? {
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
      orderBy: { createdAt: 'desc' },
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
        avatarUrl: this.toPublicUrl(like.user.avatarUrl),
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

    const response = await this.genAI.models.generateContent({
      model: 'gemini-3.1-flash-lite-preview',
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

        const uploadedFile = await this.genAI.files.upload({
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

      const response = await this.genAI.models.generateContent({
        model: 'gemini-3.1-flash-lite-preview',
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
        await this.genAI.files.delete({ name: file.name }).catch(() => {});
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

  async tutorChat(
    userId: string,
    quizId: string,
    messages: { role: 'user' | 'assistant'; text: string }[],
  ) {
    const analytics = await this.getDeckAnalytics(userId, quizId);

    const systemInstruction = `You are a friendly, encouraging AI study tutor. The student just reviewed their quiz analytics and you are here to help them understand their performance and guide them on what to focus on next.

Here is the student's analytics data for the deck "${analytics.deckTitle}":
- Subject: ${analytics.subject || 'General'}
- Total Questions: ${analytics.totalQuestions}
- Total Attempts: ${analytics.totalAnswered}
- Overall Accuracy: ${analytics.overallAccuracy}%
- Rigor Index: ${analytics.rigorIndex}
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
- Be warm, supportive, and use a conversational tone
- Keep responses concise (2-4 short paragraphs max)
- Use concrete examples from their data
- If this is the first message, introduce yourself briefly, comment on their overall performance positively, then point out one strength and one area to improve with specific advice
- Avoid overwhelming them with numbers — translate stats into plain language
- If they ask questions, answer helpfully and relate back to their specific data
- You can use emoji sparingly for friendliness`;

    const contents = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.text }],
    }));

    // If no user messages yet, add a trigger
    if (contents.length === 0) {
      contents.push({
        role: 'user',
        parts: [{ text: 'Hi! I just finished reviewing my quiz results. Can you help me understand how I did and what I should focus on?' }],
      });
    }

    const response = await this.genAI.models.generateContent({
      model: 'gemini-3.1-flash-lite-preview',
      contents,
      config: {
        systemInstruction,
      },
    });

    return { reply: response.text };
  }
}
