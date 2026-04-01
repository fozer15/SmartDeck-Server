import { Injectable, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FilesService } from '../files/files.service';
import { EnvService } from '../env/env.service';
import { GoogleGenAI } from '@google/genai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { quizResponseSchema } from './schemas/quiz.schema';
import { GenerateQuizDto } from './dto/generate-quiz.dto';
import { SubmitAnswerDto } from './dto/submit-answer.dto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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

@Injectable()
export class QuizzesService {
  private genAI: GoogleGenAI;
  private r2PublicUrl: string;
  private readonly processedAttempts = new Map<string, number>();
  private readonly processedAttemptTtlMs = 30 * 60 * 1000;
  private readonly defaultBatchSize = 5;
  private readonly maxBatchSize = 50;

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
- Provide a clear explanation for each answer`;

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
    if (!Array.isArray(deck.files)) {
      return deck;
    }

    return {
      ...deck,
      files: deck.files.map((file) => ({
        ...file,
        publicUrl: this.toPublicUrl(file.r2Key),
      })),
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

  async generate(userId: string, dto: GenerateQuizDto) {
    // Upload all files to Gemini
    const uploadedFiles: Array<{ name: string; uri: string; mimeType: string }> = [];
    const tempPaths: string[] = [];

    try {
      // Upload each file
      for (const fileId of dto.fileIds) {
        const { buffer, mimeType, originalName } = await this.filesService.getFileBuffer(fileId);
        const tempPath = path.join(os.tmpdir(), `${Date.now()}-${originalName}`);
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

      const quizData = quizResponseSchema.parse(JSON.parse(response.text));
      const generatedQuestionCount = quizData.quizzes.length;
      const generatedTiers = Array.from(new Set(quizData.quizzes.map((q) => q.tier)));
      const generatedFormats = Array.from(new Set(quizData.quizzes.map((q) => q.format)));

      // Create quiz with questions and file associations
      const createdDeck = await this.prisma.generatedQuiz.create({
        data: {
          userId,
          rigorIndex: quizData.rigorIndex,
          title: dto.title || `Untitled Quiz ${new Date().toLocaleString()}`,
          subject: dto.subject || undefined,
          questionCount: dto.questionCount || generatedQuestionCount,
          questionTier: dto.questionTier || (generatedTiers.length > 1 ? 'mixed' : generatedTiers[0]),
          questionFormat: dto.questionFormat || (generatedFormats.length > 1 ? 'mixed' : generatedFormats[0]),
          files: {
            connect: dto.fileIds.map(fileId => ({ id: fileId })),
          },
          questions: {
            create: quizData.quizzes.map((q, index) => ({
              format: q.format,
              question: q.question,
              options: q.format === 'multiple_choice' ? q.options : [],
              correctAnswer: q.correctAnswer,
              explanation: q.explanation,
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

  async findAllByUser(userId: string) {
    const decks = await this.prisma.generatedQuiz.findMany({
      where: { userId },
      include: {
        files: { select: { id: true, originalName: true, r2Key: true } },
        sessions: {
          where: { userId },
          select: { id: true, currentIndex: true, questionQueue: true, updatedAt: true },
          orderBy: { updatedAt: 'desc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return decks.map((deck) => {
      const deckWithPublicUrls = this.withDeckFilePublicUrls(deck);
      return {
        ...deckWithPublicUrls,
        sessions: deck.sessions.map((session) => ({
          id: session.id,
          currentIndex: session.currentIndex,
          updatedAt: session.updatedAt,
          questionQueueLength: session.questionQueue.length,
        })),
      };
    });
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
      where: { id: quizId, userId },
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
  ) {
    if (!answerItem.questionId) {
      return;
    }

    const question = session.quiz.questions.find((item) => item.id === answerItem.questionId);
    if (!question) {
      return;
    }

    const normalize = (value?: string) => (value || '').trim().toLowerCase();
    const isCorrect = question.format === 'flashcard'
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
          },
        },
      },
    });

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

    await this.scoreAndPersistAnswer(session, dto);
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

    return { success: true };
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
}
