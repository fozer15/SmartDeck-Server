import { Injectable, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { FilesService } from '../files/files.service';
import { GoogleGenAI } from '@google/genai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { quizResponseSchema } from './schemas/quiz.schema';
import { GenerateQuizDto } from './dto/generate-quiz.dto';
import { SubmitAnswerDto } from './dto/submit-answer.dto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

@Injectable()
export class QuizzesService {
  private genAI: GoogleGenAI;

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
    private config: ConfigService,
  ) {
    this.genAI = new GoogleGenAI({ apiKey: config.get('GEMINI_API_KEY') });
  }

  async generate(dto: GenerateQuizDto) {
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
      return this.prisma.generatedQuiz.create({
        data: {
          userId: dto.userId,
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
          files: { select: { id: true, originalName: true } },
        },
      });
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
    return this.prisma.generatedQuiz.findMany({
      where: { userId },
      include: {
        files: { select: { id: true, originalName: true } },
        questions: { orderBy: { orderIndex: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    return this.prisma.generatedQuiz.findUnique({
      where: { id },
      include: {
        files: { select: { id: true, originalName: true } },
        questions: { orderBy: { orderIndex: 'asc' } },
      },
    });
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

  async startOrResumeSession(userId: string, quizId: string) {
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
    } else if (session.questionQueue.length === 0 && questionQueue.length > 0) {
      session = await this.prisma.studySession.update({
        where: { id: session.id },
        data: {
          questionQueue,
          currentIndex: 0,
        },
      });
    }

    return this.getSession(userId, session.id);
  }

  async getSession(userId: string, sessionId: string) {
    const session = await this.prisma.studySession.findFirst({
      where: { id: sessionId, userId },
      include: {
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

    return this.buildSessionPayload(session);
  }

  async submitAnswer(userId: string, sessionId: string, dto: SubmitAnswerDto) {
    const session = await this.prisma.studySession.findFirst({
      where: { id: sessionId, userId },
      include: {
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

    const currentQuestionId = session.questionQueue[session.currentIndex];
    if (!currentQuestionId) {
      return this.buildSessionPayload(session);
    }

    if (dto.questionId !== currentQuestionId) {
      throw new ForbiddenException('Answer does not match current card');
    }

    const question = session.quiz.questions.find((q) => q.id === currentQuestionId);
    if (!question) {
      throw new NotFoundException('Question not found');
    }

    const normalize = (value?: string) => (value || '').trim().toLowerCase();
    let isCorrect = false;

    if (question.format === 'flashcard') {
      isCorrect = Boolean(dto.correct);
    } else {
      isCorrect = normalize(dto.answer) === normalize(question.correctAnswer);
    }

    await this.prisma.quizQuestion.update({
      where: { id: question.id },
      data: {
        timesAnswered: { increment: 1 },
        timesCorrect: { increment: isCorrect ? 1 : 0 },
        streak: isCorrect ? question.streak + 1 : 0,
        lastReviewed: new Date(),
      },
    });

    const nextIndex = Math.min(session.currentIndex + 1, session.questionQueue.length);

    const updatedSession = await this.prisma.studySession.update({
      where: { id: session.id },
      data: { currentIndex: nextIndex },
      include: {
        quiz: {
          include: {
            questions: { orderBy: { orderIndex: 'asc' } },
          },
        },
      },
    });

    return {
      ...this.buildSessionPayload(updatedSession),
      lastAnswer: {
        questionId: question.id,
        correct: isCorrect,
        correctAnswer: question.correctAnswer,
      },
    };
  }

  private buildSessionPayload(session: {
    id: string;
    quizId: string;
    currentIndex: number;
    questionQueue: string[];
    quiz: {
      id: string;
      title: string;
      subject: string | null;
      questions: Array<{
        id: string;
        format: string;
        question: string;
        options: string[];
        correctAnswer: string;
        explanation: string | null;
        topic: string | null;
        tier: string;
        timesAnswered: number;
      }>;
    };
  }) {
    const totalQuestions = session.questionQueue.length;
    const completedQuestions = Math.min(session.currentIndex, totalQuestions);
    const completionPercent = totalQuestions
      ? Math.round((completedQuestions / totalQuestions) * 100)
      : 0;

    const currentQuestionId = session.questionQueue[session.currentIndex] || null;
    const currentQuestion = currentQuestionId
      ? session.quiz.questions.find((q) => q.id === currentQuestionId) || null
      : null;

    return {
      id: session.id,
      quizId: session.quizId,
      title: session.quiz.title,
      subject: session.quiz.subject,
      currentIndex: session.currentIndex,
      totalQuestions,
      completedQuestions,
      completionPercent,
      isCompleted: session.currentIndex >= totalQuestions,
      currentQuestion,
    };
  }
}
