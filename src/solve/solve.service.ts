import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { BillingService } from '../billing/billing.service';
import { CreditCostType, calculateCreditsForUnits } from '../config/plan-limits';
import { GeminiService } from '../env/gemini.service';
import { FilesService } from '../files/files.service';
import { PrismaService } from '../prisma/prisma.service';

// ─── Credit cost ─────────────────────────────────────────────────────────────
// One SOLVE call = 15 credits (same as QUIZ_GENERATION), regardless of
// the number of images in the batch. The flat rate keeps billing predictable
// and reflects the fact that the model call happens once per request.
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
1. **Identify the problem type** in one sentence (e.g. "This is a quadratic equation in standard form.").
2. **State the approach / theorem / formula** you will use, with a brief justification.
3. **Work through each step** in numbered order:
   - Show the formula or rule applied.
   - Show the substitution.
   - Show the simplification.
   - Explain *why* each transformation is valid (don't just show algebra).
4. **Box or clearly label the final answer** using a display LaTeX block and a bold "**Answer:**" prefix.
5. If there are multiple parts (a, b, c …), handle each under its own heading.
6. After the solution, add a short **"Key concept"** note (1–2 sentences) that the student can use to recognize this problem type in future.

### Biology & life sciences
1. **Identify the topic** (e.g. "This question is about cellular respiration — specifically the role of ATP synthase.").
2. Give a **conceptual explanation** using clear language: define terms, describe processes, explain cause-and-effect relationships.
3. Use **headings, bullet points, and short comparisons** to organize complex information.
4. Only use LaTeX if an actual equation is required (e.g. photosynthesis or cellular respiration balanced equations).
5. End with a **"Key takeaway"** — one sentence the student should memorize.

### General / mixed / unknown subject
- If the subject is unclear, identify it first, then follow the STEM or biology guidance above as appropriate.
- If the image shows an essay question or comprehension question, provide a model answer with a clear structure (introduction, points, conclusion) and explain the reasoning.

## Tone
- Be direct and educational — you are explaining, not chatting.
- Never say "Great question!" or pad the answer with filler.
- If the student's existing work in the image contains an error, point it out kindly and explain why it is wrong before showing the correct approach.`;

@Injectable()
export class SolveService {
  private readonly logger = new Logger(SolveService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly filesService: FilesService,
    private readonly billing: BillingService,
    private readonly gemini: GeminiService,
  ) {}

  async solve(
    userId: string,
    input: { fileIds: string[]; note?: string },
  ) {
    const uniqueFileIds = Array.from(new Set(input.fileIds.filter(Boolean)));

    if (uniqueFileIds.length === 0) {
      throw new BadRequestException('At least one image is required.');
    }

    // ── 1. Verify all files belong to the user and are images ────────────────
    const files = await this.prisma.uploadedFile.findMany({
      where: { id: { in: uniqueFileIds }, userId },
      select: { id: true, r2Key: true, mimeType: true, originalName: true },
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

    // ── 2. Credit check ───────────────────────────────────────────────────────
    const creditSummary = await this.billing.getCreditSummary(userId);
    if (creditSummary.remainingCredits < SOLVE_CREDIT_COST) {
      return {
        status: 'credits_needed' as const,
        requiredCredits: SOLVE_CREDIT_COST,
        remainingCredits: creditSummary.remainingCredits,
        monthlyCredits: creditSummary.monthlyCredits,
      };
    }

    // ── 3. Download images from R2 ────────────────────────────────────────────
    const buffers = await Promise.all(
      files.map((f) => this.filesService.getObjectBuffer(f.r2Key)),
    );

    // ── 4. Write to tmp, upload to Gemini File API ────────────────────────────
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

          geminiFiles.push({
            name: uploaded.name,
            uri: uploaded.uri,
            mimeType: file.mimeType,
          });
        }),
      );

      // ── 5. Build the Gemini request ─────────────────────────────────────────
      // Images first, then the optional user note.
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

      const solution = String(response.text || '').trim();
      if (!solution) {
        throw new InternalServerErrorException('Gemini returned an empty solution.');
      }

      // ── 6. Charge only on success ───────────────────────────────────────────
      await this.billing.consumeCredits(userId, SOLVE_CREDIT_COST, 'Solve');

      return {
        status: 'ok' as const,
        solution,
        creditsCharged: SOLVE_CREDIT_COST,
        imageCount: files.length,
      };
    } finally {
      // Clean up local temp files synchronously.
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
      // Delete Gemini-side files in the background (they auto-expire at 48h).
      void Promise.allSettled(
        geminiFiles.map((gf) => this.gemini.deleteFile({ name: gf.name }).catch(() => undefined)),
      );
    }
  }
}
