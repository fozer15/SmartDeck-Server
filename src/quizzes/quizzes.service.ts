import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { FilesService } from '../files/files.service';
import { GoogleGenAI } from '@google/genai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { quizResponseSchema } from './schemas/quiz.schema';
import { GenerateQuizDto } from './dto/generate-quiz.dto';
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
- Create 5-10 questions covering the main topics
- Mix all three tiers
- Include 4 options per question
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

      const prompt = dto.instructions
        ? `${this.systemPrompt}\n\nAdditional instructions: ${dto.instructions}`
        : this.systemPrompt;

      // Generate quiz from all files
      const response = await this.genAI.models.generateContent({
        model: 'gemini-2.5-flash-preview',
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

      // Create quiz with questions and file associations
      return this.prisma.generatedQuiz.create({
        data: {
          userId: dto.userId,
          rigorIndex: quizData.rigorIndex,
          files: {
            create: dto.fileIds.map(fileId => ({ fileId })),
          },
          questions: {
            create: quizData.quizzes.map((q, index) => ({
              question: q.question,
              options: q.options,
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
          files: { include: { file: { select: { originalName: true } } } },
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

  async findAllByUser(userId: string) {
    return this.prisma.generatedQuiz.findMany({
      where: { userId },
      include: {
        files: { include: { file: { select: { originalName: true } } } },
        questions: { orderBy: { orderIndex: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    return this.prisma.generatedQuiz.findUnique({
      where: { id },
      include: {
        files: { include: { file: { select: { originalName: true } } } },
        questions: { orderBy: { orderIndex: 'asc' } },
      },
    });
  }
}
