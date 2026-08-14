import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SolveJobStatus } from '@prisma/client';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { BillingService } from '../billing/billing.service';
import { CreditCostType, calculateCreditsForUnits } from '../config/plan-limits';
import { GeminiService } from '../env/gemini.service';
import { FilesService } from '../files/files.service';
import { PrismaService } from '../prisma/prisma.service';
import { SolveJobQueueService } from './solve-job.queue.service';

// ─── Zod Schema ──────────────────────────────────────────────────────────────
const solveResponseSchema = z.object({
  answer: z.string(),
  steps: z.string().optional(),
  explanation: z.string().optional(),
  diagram_svg: z.string().optional(),
});

// ─── Credit cost ─────────────────────────────────────────────────────────────
const SOLVE_CREDIT_COST = calculateCreditsForUnits(CreditCostType.SOLVE, 1);
const TUTOR_CHAT_COST = calculateCreditsForUnits(CreditCostType.TUTOR_CHAT_MESSAGE, 1);

// ─── Gemini system instruction ────────────────────────────────────────────────
const SOLVE_SYSTEM_INSTRUCTION = `You are an expert academic tutor. Analyze the provided image(s) and student notes to produce a concise, complete solution strictly in valid JSON format.

## Output JSON Schema
Your response MUST be a single JSON object containing the following fields:
1. "answer": The final concise result or boxed answer (use display LaTeX for math).
2. "steps" OR "explanation":
   - For STEM (Math, Physics, Chemistry, CS, Stats): Use key "steps" with a concise, numbered step-by-step solution.
   - For Biology, Life Sciences, or General/Humanities: Use key "explanation" with a structured conceptual breakdown.
3. "diagram_svg" (OPTIONAL): If the problem involves geometry, graphs, circuits, or physical setups, provide a clean, valid, raw SVG string to illustrate it. 
   - Use a flexible viewBox (e.g., viewBox='0 0 200 200').
   - CRITICAL: Use single quotes for all SVG attributes to avoid breaking the JSON (e.g., <rect x='10' y='10' width='50' height='50' stroke='black' fill='none' />).
   - Omit this field entirely if no diagram is necessary.

Example JSON for STEM with Diagram (Notice the double-escaped backslashes for ALL LaTeX macros and single quotes in SVG):
{
  "answer": "\\\\[ c \\\\approx 5.83 \\\\]",
  "steps": "1. **Use Law of Cosines:** \\\\( c^2 = a^2 + b^2 - 2ab \\\\cos(C) \\\\)\\n2. **Substitute values:** \\\\[ c = \\\\sqrt{3^2 + 4^2 - 2(3)(4)\\\\cos(90^\\\\circ)} \\\\]...",
  "diagram_svg": "<svg viewBox='0 0 100 100'><polygon points='10,90 90,90 10,10' fill='none' stroke='black'/><text x='45' y='98' font-size='10'>4</text><text x='2' y='50' font-size='10'>3</text></svg>"
}

## Formatting & LaTeX Rules
- Content inside "steps" or "explanation" MUST use GitHub-Flavored Markdown.
- CRITICAL: Because you are generating JSON, you MUST double-escape ALL LaTeX backslashes and newlines. 
  - Inline math: \\\\( expression \\\\)
  - Display math: \\\\[ expression \\\\]
  - Fractions/symbols: \\\\frac, \\\\sqrt, \\\\pm, \\\\rightarrow, \\\\cos, \\\\circ, \\\\implies
- Never write raw ASCII math like "x^2 + 3x".
- Do NOT include conversational filler, greetings, or extra fields.
- Base your solution ONLY on visible image content. If unreadable, state what is missing.`;

// ─── Title-generation prompt ──────────────────────────────────────────────────
const TITLE_SYSTEM_INSTRUCTION = `You generate ultra-short titles for academic problem solutions.
Rules:
- Maximum 8 words.
- Capture the subject and core concept (e.g. "Quadratic Formula – Projectile Motion", "Cellular Respiration: ATP Synthesis", "Integration by Parts – Trigonometric Integral").
- No LaTeX, no markdown, no punctuation other than a dash or colon to separate subject from concept.
- Output ONLY the title string — no explanation, no quotes.`;

const TUTOR_CHAT_SYSTEM_INSTRUCTION = `You are a helpful, expert AI academic tutor.
The user is asking a follow-up question about a specific problem they recently solved.
You will be provided with the original solution generated for the student as context.
Use this context to answer their question, simplify the explanation, provide examples, or break down the steps further.

## Formatting Rules
- Format your response in clean GitHub-Flavored Markdown.
- Double-escape ALL LaTeX backslashes and newlines just like the main solver.
  - Inline math: \\\\( expression \\\\)
  - Display math: \\\\[ expression \\\\]
- Be warm, encouraging, and highly educational.`;

@Injectable()
export class SolveService {
  private readonly logger = new Logger(SolveService.name);
  private readonly solveGenerationRetryAttempts = 3;

  constructor(
    private readonly prisma: PrismaService,
    private readonly filesService: FilesService,
    private readonly billing: BillingService,
    private readonly gemini: GeminiService,
    private readonly queue: SolveJobQueueService,
  ) {}

  // ─── Error Handling & Retries ──────────────────────────────────────────────

  private isRetryableSolveSchemaError(error: unknown) {
    return error instanceof SyntaxError || error instanceof z.ZodError;
  }

  private summarizeSolveSchemaError(error: unknown) {
    if (error instanceof z.ZodError) {
      return error.issues
        .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
        .join('; ');
    }
    if (error instanceof Error && error.message) {
      return error.message;
    }
    return 'Unknown structured-output validation error.';
  }

  private buildSolveRetryInstruction(error: unknown) {
    const errorSummary = this.summarizeSolveSchemaError(error);
    return [
      'The previous response was rejected because it failed JSON parsing or schema validation.',
      `Validation failure summary: ${errorSummary}`,
      'Return the entire response again as valid JSON only.',
      'CRITICAL: Ensure ALL LaTeX backslashes are double-escaped (e.g., \\\\frac instead of \\frac). A single unescaped backslash will break the JSON parser.',
      'CRITICAL: Do not wrap your response in markdown code blocks (```json ... ```). Output raw JSON only.',
    ].join('\n');
  }

  // ─── Enqueue ───────────────────────────────────────────────────────────────

  async enqueueSolveJob(userId: string, input: { fileIds: string[]; note?: string }) {
    const uniqueFileIds = Array.from(new Set(input.fileIds.filter(Boolean)));

    if (uniqueFileIds.length === 0) {
      throw new BadRequestException('At least one image is required.');
    }
    if (uniqueFileIds.length > 10) {
      throw new BadRequestException('At most 10 images are allowed per solve request.');
    }

    const files = await this.prisma.uploadedFile.findMany({
      where: { id: { in: uniqueFileIds }, userId },
      select: { id: true, mimeType: true, originalName: true },
    });

    if (files.length !== uniqueFileIds.length) {
      const foundIds = new Set(files.map((f) => f.id));
      const missing = uniqueFileIds.find((id) => !foundIds.has(id));
      throw new BadRequestException(`File ${missing} not found or not owned by user.`);
    }

    for (const file of files) {
      const mime = String(file.mimeType || '').toLowerCase();
      if (!mime.startsWith('image/')) {
        throw new BadRequestException(
          `File "${file.originalName}" is not an image (${file.mimeType}). Only images are supported for Solve.`,
        );
      }
    }

    const creditSummary = await this.billing.getCreditSummary(userId);
    if (!creditSummary.isUnlimited && creditSummary.remainingCredits < SOLVE_CREDIT_COST) {
      return {
        status: 'credits_needed' as const,
        requiredCredits: SOLVE_CREDIT_COST,
        remainingCredits: creditSummary.remainingCredits,
        dailyCredits: creditSummary.dailyCredits,
      };
    }

    const job = await this.prisma.solveJob.create({
      data: {
        userId,
        note: input.note ?? null,
        status: SolveJobStatus.queued,
        sourceFiles: { connect: uniqueFileIds.map((id) => ({ id })) },
      },
    });

    await this.queue.enqueueSolveJob(job.id);

    return {
      status: 'queued' as const,
      jobId: job.id,
    };
  }

  // ─── Process (called by worker) ────────────────────────────────────────────

  async processSolveJob(jobId: string) {
    const transition = await this.prisma.solveJob.updateMany({
      where: { id: jobId, status: SolveJobStatus.queued },
      data: {
        status: SolveJobStatus.processing,
        startedAt: new Date(),
        attempts: { increment: 1 },
        errorMessage: null,
        completedAt: null,
      },
    });

    if (transition.count === 0) {
      return;
    }

    const job = await this.prisma.solveJob.findUnique({
      where: { id: jobId },
      include: { sourceFiles: { select: { id: true } } },
    });
    if (!job) throw new NotFoundException('Solve job not found');

    const fileIds = job.sourceFiles.map((f) => f.id);

    try {
      const solution = await this.runSolve(job.userId, { fileIds, note: job.note ?? undefined });

      await this.billing.consumeCredits(job.userId, SOLVE_CREDIT_COST, 'Solve');

      const generatedSolution = await this.prisma.generatedSolution.create({
        data: {
          userId: job.userId,
          content: solution,
          sourceFiles: { connect: fileIds.map((id) => ({ id })) },
        },
      });

      this.generateSolutionTitle(generatedSolution.id, solution).catch((err) => {
        this.logger.warn(`Title generation failed for solution ${generatedSolution.id}: ${err?.message}`);
      });

      await this.prisma.solveJob.update({
        where: { id: job.id },
        data: {
          status: SolveJobStatus.completed,
          resultSolutionId: generatedSolution.id,
          completedAt: new Date(),
          errorMessage: null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Solve job ${job.id} failed: ${message}`);

      await this.prisma.solveJob
        .update({
          where: { id: job.id },
          data: {
            status: SolveJobStatus.failed,
            errorMessage: message,
            completedAt: new Date(),
          },
        })
        .catch(() => {});

      throw error;
    }
  }

  // ─── Poll / list ───────────────────────────────────────────────────────────

  async listSolveJobs(userId: string) {
    const jobs = await this.prisma.solveJob.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        status: true,
        note: true,
        errorMessage: true,
        attempts: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
        updatedAt: true,
        resultSolutionId: true,
        sourceFiles: {
          select: { id: true, originalName: true, mimeType: true, size: true },
        },
      },
    });
    return { jobs };
  }

  async getSolveJob(userId: string, jobId: string) {
    const job = await this.prisma.solveJob.findFirst({
      where: { id: jobId, userId },
      include: {
        sourceFiles: {
          select: { id: true, originalName: true, mimeType: true, size: true },
        },
        resultSolution: {
          select: {
            id: true,
          },
        },
      },
    });
    if (!job) throw new NotFoundException('Solve job not found');
    return job;
  }

  // ─── Solution history endpoints ────────────────────────────────────────────

  async listSolutions(userId: string) {
    const solutions = await this.prisma.generatedSolution.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        title: true,
        createdAt: true,
        updatedAt: true,
        sourceFiles: {
          select: { id: true, originalName: true, mimeType: true, size: true, r2Key: true },
          take: 1,
        },
      },
    });
    return { solutions };
  }

  async getSolution(userId: string, solutionId: string) {
    const solution = await this.prisma.generatedSolution.findFirst({
      where: { id: solutionId, userId },
      select: {
        id: true,
        title: true,
        content: true,
        createdAt: true,
        updatedAt: true,
        sourceFiles: {
          select: { id: true, originalName: true, mimeType: true, size: true, r2Key: true },
        },
        solveJob: {
          select: { id: true, note: true, status: true, createdAt: true },
        },
      },
    });
    if (!solution) throw new NotFoundException('Solution not found');
    return solution;
  }

  // ─── Core Gemini logic (private) ───────────────────────────────────────────

  private async generateSolutionTitle(solutionId: string, content: string): Promise<void> {
    const excerpt = content.slice(0, 1000);

    const response = await this.gemini.generateContent({
      contents: [{ role: 'user', parts: [{ text: `Solution excerpt:\n\n${excerpt}` }] }],
      config: { systemInstruction: TITLE_SYSTEM_INSTRUCTION },
    });

    const raw = String(response.text || '').trim();
    if (!raw) return;

    const title = raw.replace(/^["']|["']$/g, '').slice(0, 80);

    await this.prisma.generatedSolution.update({
      where: { id: solutionId },
      data: { title },
    });
  }

  private async runSolve(
    userId: string,
    input: { fileIds: string[]; note?: string },
  ): Promise<string> {
    const files = await this.prisma.uploadedFile.findMany({
      where: { id: { in: input.fileIds }, userId },
      select: { id: true, r2Key: true, mimeType: true, originalName: true },
    });

    const buffers = await Promise.all(
      files.map((f) => this.filesService.getObjectBuffer(f.r2Key)),
    );

    const baseParts: Array<Record<string, unknown>> = files.map((file, i) => ({
      inlineData: {
        mimeType: file.mimeType,
        data: buffers[i].buffer.toString('base64'),
      },
    }));

    const userText = input.note?.trim()
      ? `Please solve the problem(s) in the image(s). Additional note from the student: ${input.note.trim()}`
      : 'Please solve the problem(s) shown in the image(s).';

    let retryInstruction: string | undefined;
    let lastValidationError: unknown;

    // Retry Loop for Gemini Validation
    for (let attempt = 1; attempt <= this.solveGenerationRetryAttempts; attempt += 1) {
      const parts = [...baseParts];
      parts.push({
        text: retryInstruction ? `${userText}\n\n${retryInstruction}` : userText,
      });

      const response = await this.gemini.generateContent({
        contents: [{ role: 'user', parts }],
        config: {
          systemInstruction: `${SOLVE_SYSTEM_INSTRUCTION}\nIMPORTANT: You are generating raw JSON. Every backslash in LaTeX commands MUST be double-escaped (e.g. \\\\sqrt instead of \\sqrt).`,
          responseMimeType: 'application/json',
          // Optional: if your gemini service wraps standard Google AI SDK, you can also pass responseSchema here:
          // responseSchema: zodToJsonSchema(solveResponseSchema as any),
        },
      });

      const rawText = String(response.text || '').trim();

      try {
        if (!rawText) {
          throw new SyntaxError('Model returned an empty JSON response.');
        }

        // Clean up markdown block wrappers occasionally output by the model despite responseMimeType
        const cleanText = rawText.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();

        // 1. Attempt JSON parsing
        const parsedData = JSON.parse(cleanText);

        // 2. Validate against Zod schema
        const validatedData = solveResponseSchema.parse(parsedData);

        return JSON.stringify(validatedData);
      } catch (error) {
        if (!this.isRetryableSolveSchemaError(error)) {
          throw error;
        }

        lastValidationError = error;
        const summary = this.summarizeSolveSchemaError(error);

        if (attempt >= this.solveGenerationRetryAttempts) {
          this.logger.error(
            `Solve generation returned invalid structured data after ${attempt} attempts: ${summary}`,
          );
          throw new InternalServerErrorException(
            `Solve generation failed validation after ${this.solveGenerationRetryAttempts} attempts: ${summary}`,
          );
        }

        this.logger.warn(
          `Retrying solve generation after invalid structured response on attempt ${attempt}/${this.solveGenerationRetryAttempts}: ${summary}`,
        );
        
        retryInstruction = this.buildSolveRetryInstruction(error);
      }
    }

    throw new InternalServerErrorException('Solve generation failed.');
  }

  async deleteSolution(userId: string, solutionId: string) {
    const solution = await this.prisma.generatedSolution.findFirst({
      where: { id: solutionId, userId },
    });

    if (!solution) {
      throw new NotFoundException('Solution not found');
    }

    await this.prisma.generatedSolution.delete({
      where: { id: solutionId },
    });

    return { success: true };
  }

  // ─── Tutor Chat ────────────────────────────────────────────────────────────

  async getSolutionMessages(userId: string, solutionId: string, limit: number, cursor?: string) {
    const solutionExists = await this.prisma.generatedSolution.findFirst({
      where: { id: solutionId, userId },
      select: { id: true },
    });

    if (!solutionExists) {
      throw new NotFoundException('Solution not found or access denied');
    }

    const query: any = {
      where: { solutionId, userId },
      take: limit,
      orderBy: { createdAt: 'desc' },
    };

    if (cursor) {
      query.cursor = { id: cursor };
      query.skip = 1;
    }

    const messages = await this.prisma.solutionMessage.findMany(query);
    const nextCursor = messages.length === limit ? messages[messages.length - 1].id : null;

    return {
      messages: messages.reverse(),
      nextCursor,
    };
  }

  async chatAboutSolution(
    userId: string,
    solutionId: string,
    input: { message: string; history?: Array<{ role: string; text: string }> },
  ) {
    const solution = await this.prisma.generatedSolution.findFirst({
      where: { id: solutionId, userId },
      select: { id: true, content: true },
    });

    if (!solution) {
      throw new NotFoundException('Solution not found or access denied');
    }

    const creditSummary = await this.billing.getCreditSummary(userId);
    if (!creditSummary.isUnlimited && creditSummary.remainingCredits < TUTOR_CHAT_COST) {
      return {
        status: 'credits_needed' as const,
        requiredCredits: TUTOR_CHAT_COST,
        remainingCredits: creditSummary.remainingCredits,
        dailyCredits: creditSummary.dailyCredits,
      };
    }

    await this.prisma.solutionMessage.create({
      data: {
        userId,
        solutionId,
        role: 'user',
        text: input.message,
      },
    });

    const parts = [];
    const contextPrompt = `Context: The student is asking about the following solution they received:\n\n${solution.content}\n\n`;

    if (input.history && input.history.length > 0) {
      const historyString = input.history
        .map((msg) => `${msg.role === 'user' ? 'Student' : 'Tutor'}: ${msg.text}`)
        .join('\n\n');
      parts.push({
        text: `${contextPrompt}Conversation History:\n${historyString}\n\nStudent's new message: ${input.message}`,
      });
    } else {
      parts.push({ text: `${contextPrompt}Student's question: ${input.message}` });
    }

    try {
      const response = await this.gemini.generateContent({
        contents: [{ role: 'user', parts }],
        config: {
          systemInstruction: TUTOR_CHAT_SYSTEM_INSTRUCTION,
        },
      });

      const rawText = String(response.text || '').trim();

      if (!rawText) {
        throw new InternalServerErrorException('AI returned an empty response.');
      }

      await this.prisma.solutionMessage.create({
        data: {
          userId,
          solutionId,
          role: 'assistant',
          text: rawText,
        },
      });

      await this.billing.consumeCredits(userId, TUTOR_CHAT_COST, 'Tutor Chat');

      return { reply: rawText };
    } catch (error) {
      this.logger.error(`Tutor Chat failed for solution ${solutionId}:`, error);
      throw new InternalServerErrorException('Failed to communicate with AI Tutor.');
    }
  }
}
