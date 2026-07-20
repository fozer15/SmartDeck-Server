import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SolveJobStatus } from '@prisma/client';

import { BillingService } from '../billing/billing.service';
import { CreditCostType, calculateCreditsForUnits } from '../config/plan-limits';
import { GeminiService } from '../env/gemini.service';
import { FilesService } from '../files/files.service';
import { PrismaService } from '../prisma/prisma.service';
import { SolveJobQueueService } from './solve-job.queue.service';

// ─── Credit cost ─────────────────────────────────────────────────────────────
const SOLVE_CREDIT_COST = calculateCreditsForUnits(CreditCostType.SOLVE, 1);

// ─── Gemini system instruction ────────────────────────────────────────────────
const SOLVE_SYSTEM_INSTRUCTION = `You are an expert academic tutor and problem solver. The student has shared one or more images that may contain handwritten notes, textbook questions, printed problems, diagrams, formulas, graphs, or partial work. Your job is to analyze the image(s) and produce a clear, complete solution.

## Grounding rules
- Base your answer ONLY on what is visible in the provided image(s) and any extra note the student added.
- If the problem is partially cut off or unreadable, state what you can see and ask the student to re-upload a clearer image rather than guessing.
- Do NOT invent numbers, variables, or sub-questions that are not in the images.
- If multiple images are provided, treat them as parts of the same problem unless the student says otherwise.

## Output format
- Always respond in **GitHub-Flavored Markdown**.
- Write ALL mathematical expressions, equations, formulas, and numerical results using **LaTeX**:
  - Inline: \\( expression \\)
  - Display (block): \\[ expression \\]
- Use display-block LaTeX for any multi-step equation or final answer.
- Never write raw ASCII math like "x^2 + 3x" — always use LaTeX.
- Do NOT wrap your entire response in a fenced code block.

## Subject-specific guidance

### STEM (mathematics, physics, chemistry, statistics, computer science)
1. **Identify the problem type** in one sentence.
2. **State the approach / theorem / formula** you will use, with a brief justification.
3. **Work through each step** in numbered order: show formula, substitution, simplification, and explain *why* each step is valid.
4. **Box or clearly label the final answer** using a display LaTeX block and a bold "**Answer:**" prefix.
5. If there are multiple parts (a, b, c …), handle each under its own heading.
6. After the solution, add a short **"Key concept"** note (1–2 sentences).

### Biology & life sciences
1. **Identify the topic**.
2. Give a **conceptual explanation**: define terms, describe processes, explain cause-and-effect.
3. Use **headings, bullet points, and short comparisons**.
4. Only use LaTeX if an actual equation is required.
5. End with a **"Key takeaway"** — one sentence the student should memorize.

### General / mixed / unknown subject
- Identify the subject first, then follow the STEM or biology guidance above.
- For essay or comprehension questions, provide a model answer with clear structure and reasoning.

## Tone
- Be direct and educational — you are explaining, not chatting.
- Never say "Great question!" or pad the answer with filler.
- If the student's existing work contains an error, point it out kindly and explain why it is wrong before showing the correct approach.`;

// ─── Title-generation prompt ──────────────────────────────────────────────────
const TITLE_SYSTEM_INSTRUCTION = `You generate ultra-short titles for academic problem solutions.
Rules:
- Maximum 8 words.
- Capture the subject and core concept (e.g. "Quadratic Formula – Projectile Motion", "Cellular Respiration: ATP Synthesis", "Integration by Parts – Trigonometric Integral").
- No LaTeX, no markdown, no punctuation other than a dash or colon to separate subject from concept.
- Output ONLY the title string — no explanation, no quotes.`;

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

    const tempPaths: string[] = [];
    const geminiFiles: Array<{ name: string; uri: string; mimeType: string }> = [];

    try {
      await Promise.all(
        files.map(async (file, i) => {
          const tempPath = path.join(
            os.tmpdir(),
            `${Date.now()}-solve-${file.id}-${file.originalName}`,
          );
          fs.writeFileSync(tempPath, buffers[i].buffer);
          tempPaths.push(tempPath);

          const uploaded = await this.gemini.uploadFile({
            file: tempPath,
            config: { mimeType: file.mimeType, displayName: file.originalName },
          });

          geminiFiles.push({ name: uploaded.name, uri: uploaded.uri, mimeType: file.mimeType });
        }),
      );

      const parts: Array<Record<string, unknown>> = geminiFiles.map((gf) => ({
        fileData: { mimeType: gf.mimeType, fileUri: gf.uri },
      }));

      const userText = input.note?.trim()
        ? `Please solve the problem(s) in the image(s). Additional note from the student: ${input.note.trim()}`
        : 'Please solve the problem(s) shown in the image(s).';

      parts.push({ text: userText });

      const response = await this.gemini.generateContent({
        contents: [{ role: 'user', parts }],
        config: { systemInstruction: SOLVE_SYSTEM_INSTRUCTION },
      });
      console.log(response);
      const solution = String(response.text || '').trim();
      if (!solution) {
        throw new InternalServerErrorException('Gemini returned an empty solution.');
      }

      return solution;
    } finally {
      for (const tempPath of tempPaths) {
        if (fs.existsSync(tempPath)) {
          try {
            fs.unlinkSync(tempPath);
          } catch (err) {
            this.logger.warn(
              `Failed to remove temp file ${tempPath}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
      void Promise.allSettled(
        geminiFiles.map((gf) => this.gemini.deleteFile({ name: gf.name }).catch(() => undefined)),
      );
    }
  }
}
