import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SolveJobStatus } from '@prisma/client';

import { BillingService } from '../billing/billing.service';
import { CreditCostType, calculateCreditsForUnits } from '../config/plan-limits';
import { GeminiService } from '../env/gemini.service';
import { FilesService } from '../files/files.service';
import { PrismaService } from '../prisma/prisma.service';
import { SolveJobQueueService } from './solve-job.queue.service';

// ─── Credit cost ─────────────────────────────────────────────────────────────
const SOLVE_CREDIT_COST = calculateCreditsForUnits(CreditCostType.SOLVE, 1);
const TUTOR_CHAT_COST = calculateCreditsForUnits(CreditCostType.TUTOR_CHAT_MESSAGE,1)
// ─── Gemini system instruction ────────────────────────────────────────────────
// ─── Gemini system instruction ────────────────────────────────────────────────
const SOLVE_SYSTEM_INSTRUCTION = `You are an expert academic tutor. Analyze the provided image(s) and student notes to produce a concise, complete solution strictly in valid JSON format.

## Output JSON Schema
Your response MUST be a single JSON object containing EXACTLY two fields:
1. "answer": The final concise result or boxed answer (use display LaTeX for math).
2. The second field depends on the subject:
   - For STEM (Math, Physics, Chemistry, CS, Stats): Use key "steps" with a concise, numbered step-by-step solution.
   - For Biology, Life Sciences, or General/Humanities: Use key "explanation" with a structured conceptual breakdown.

Example JSON for STEM (Notice the double-escaped backslashes):
{
  "answer": "\\\\[ x = \\\\frac{-b \\\\pm \\\\sqrt{b^2 - 4ac}}{2a} \\\\]",
  "steps": "1. **Identify coefficients:** \\\\( a = 1, b = -3, c = 2 \\\\)\\n2. **Apply quadratic formula:** ..."
}

Example JSON for Biology/General:
{
  "answer": "Photosynthesis occurs in the chloroplasts, converting light energy into chemical energy.",
  "explanation": "### Process Breakdown\\n* **Light-Dependent Reactions:** Occur in thylakoid membranes..."
}

## Formatting & LaTeX Rules
- Content inside "steps" or "explanation" MUST use GitHub-Flavored Markdown.
- CRITICAL: Because you are generating JSON, you MUST double-escape ALL LaTeX backslashes and newlines. 
  - Inline math: \\\\( expression \\\\)
  - Display math: \\\\[ expression \\\\]
  - Fractions/symbols: \\\\frac, \\\\sqrt, \\\\pm, \\\\rightarrow
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

// Assuming a chat costs 1 credit, adjust this based on your CreditCostType enum if needed
const CHAT_CREDIT_COST = 1;

@Injectable()
export class SolveService {
  private readonly logger = new Logger(SolveService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly filesService: FilesService,
    private readonly billing: BillingService,
    private readonly gemini: GeminiService,
    private readonly queue: SolveJobQueueService,
  ) {}

  // ─── Enqueue ───────────────────────────────────────────────────────────────

  async enqueueSolveJob(userId: string, input: { fileIds: string[]; note?: string }) {
    const uniqueFileIds = Array.from(new Set(input.fileIds.filter(Boolean)));

    if (uniqueFileIds.length === 0) {
      throw new BadRequestException('At least one image is required.');
    }
    if (uniqueFileIds.length > 10) {
      throw new BadRequestException('At most 10 images are allowed per solve request.');
    }

    // Verify files belong to user and are images before creating the job.
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

    // Credit pre-check (non-binding — actual charge happens on completion).
    const creditSummary = await this.billing.getCreditSummary(userId);
    if (creditSummary.remainingCredits < SOLVE_CREDIT_COST) {
      return {
        status: 'credits_needed' as const,
        requiredCredits: SOLVE_CREDIT_COST,
        remainingCredits: creditSummary.remainingCredits,
        monthlyCredits: creditSummary.monthlyCredits,
      };
    }

    const job = await this.prisma.solveJob.create({
      data: {
        userId,
        note: input.note ?? null,
        status: SolveJobStatus.queued,
        // Connect source files at creation time so they're immediately accessible.
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
    // Atomic queued → processing guard to prevent double-processing.
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
      return; // Already picked up or cancelled — skip silently.
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

      // Create the GeneratedSolution record and link source files.
      const generatedSolution = await this.prisma.generatedSolution.create({
        data: {
          userId: job.userId,
          content: solution,
          sourceFiles: { connect: fileIds.map((id) => ({ id })) },
        },
      });

      // Generate a short title in the background — failures must NOT block the job.
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

  /**
   * Lightweight list for the history screen.
   * Returns title + the FIRST source image only — no solution content.
   */
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
        // Only the first image — client renders a thumbnail
        sourceFiles: {
          select: { id: true, originalName: true, mimeType: true, size: true, r2Key: true },
          take: 1,
        },
      },
    });
    return { solutions };
  }

  /**
   * Full detail view — includes solution content and all source images.
   */
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

  /**
   * Fire-and-forget: ask Gemini for a short title derived from the solution
   * content, then persist it. Called after the solution row is created.
   */
  private async generateSolutionTitle(solutionId: string, content: string): Promise<void> {
    // Feed only the first ~1 000 chars to keep the title call cheap.
    const excerpt = content.slice(0, 1000);

    const response = await this.gemini.generateContent({
      contents: [{ role: 'user', parts: [{ text: `Solution excerpt:\n\n${excerpt}` }] }],
      config: { systemInstruction: TITLE_SYSTEM_INSTRUCTION },
    });

    const raw = String(response.text || '').trim();
    if (!raw) return;

    // Hard-cap at 80 chars in case the model disobeys.
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

    // Pass image buffers directly as inline Base64 data (eliminates disk I/O & File API overhead)
    const parts: Array<Record<string, unknown>> = files.map((file, i) => ({
      inlineData: {
        mimeType: file.mimeType,
        data: buffers[i].buffer.toString('base64'),
      },
    }));

    const userText = input.note?.trim()
      ? `Please solve the problem(s) in the image(s). Additional note from the student: ${input.note.trim()}`
      : 'Please solve the problem(s) shown in the image(s).';

    parts.push({ text: userText });

    const response = await this.gemini.generateContent({
      contents: [{ role: 'user', parts }],
      config: {
        systemInstruction: SOLVE_SYSTEM_INSTRUCTION,
        responseMimeType: 'application/json',
      },
    });

    const rawText = String(response.text || '').trim();
    if (!rawText) {
      throw new InternalServerErrorException('Gemini returned an empty solution.');
    }

    try {
      const parsedSolution = JSON.parse(rawText);
      return JSON.stringify(parsedSolution);
    } catch (err) {
      this.logger.error(`Failed to parse Gemini JSON output: ${rawText}`);
      throw new InternalServerErrorException('Invalid solution format returned from solver.');
    }
  }

  async deleteSolution(userId: string, solutionId: string) {
    // 1. Verify ownership and existence
    const solution = await this.prisma.generatedSolution.findFirst({
      where: { id: solutionId, userId },
    });

    if (!solution) {
      throw new NotFoundException('Solution not found');
    }

    // 2. Delete the solution
    await this.prisma.generatedSolution.delete({
      where: { id: solutionId },
    });

    return { success: true };
  }

  // ─── Tutor Chat ────────────────────────────────────────────────────────────
  
  async chatAboutSolution(userId: string, solutionId: string, input: { message: string; history?: Array<{role: string, text: string}> }) {
    // 1. Verify solution exists and belongs to the user
    const solution = await this.prisma.generatedSolution.findFirst({
      where: { id: solutionId, userId },
      select: { id: true, content: true }
    });
    console.log("insiddeede")
    if (!solution) {
      throw new NotFoundException('Solution not found or access denied');
    }

    // 2. Pre-check credits (Optional: depending on if you want to charge for chats)
    const creditSummary = await this.billing.getCreditSummary(userId);
    if (creditSummary.remainingCredits < TUTOR_CHAT_COST) {
       console.log("no credit")
      return {
        status: 'credits_needed' as const,
        requiredCredits: TUTOR_CHAT_COST,
        remainingCredits: creditSummary.remainingCredits,
        monthlyCredits: creditSummary.monthlyCredits,
      };
    }

    // 3. Build the context and conversation history
    const parts = [];
    
    // Inject the original solution context secretly so Gemini knows what we are talking about
    const contextPrompt = `Context: The student is asking about the following solution they received:\n\n${solution.content}\n\n`;
    
    // If the client sends chat history, append it
    if (input.history && input.history.length > 0) {
      // (Optional) You can map history into Gemini's multi-turn format here 
      // For simplicity in a single call, we can stringify the history:
      const historyString = input.history.map(msg => `${msg.role === 'user' ? 'Student' : 'Tutor'}: ${msg.text}`).join('\n\n');
      parts.push({ text: `${contextPrompt}Conversation History:\n${historyString}\n\nStudent's new message: ${input.message}` });
    } else {
      parts.push({ text: `${contextPrompt}Student's question: ${input.message}` });
    }

    // 4. Ask Gemini
    try {
      const response = await this.gemini.generateContent({
        contents: [{ role: 'user', parts }],
        config: { 
          systemInstruction: TUTOR_CHAT_SYSTEM_INSTRUCTION,
          // Not restricting to JSON here, regular markdown string is preferred for chat
        },
      });

      const rawText = String(response.text || '').trim();
      
      if (!rawText) {
        throw new InternalServerErrorException('AI returned an empty response.');
      }

      // 5. Consume Credits
      await this.billing.consumeCredits(userId, TUTOR_CHAT_COST, 'Tutor Chat');
      console.log("hererere")
      return { reply: rawText };
      
    } catch (error) {
      this.logger.error(`Tutor Chat failed for solution ${solutionId}:`, error);
      throw new InternalServerErrorException('Failed to communicate with AI Tutor.');
    }
  }
}
