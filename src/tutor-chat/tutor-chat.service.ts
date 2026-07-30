import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AppLanguage } from '@prisma/client';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PDFDocument } from 'pdf-lib';

import { BillingService } from '../billing/billing.service';
import { CreditCostType, calculateCreditsForUnits } from '../config/plan-limits';
import { GeminiService } from '../env/gemini.service';
import { FilesService } from '../files/files.service';
import { PrismaService } from '../prisma/prisma.service';
import { QuizzesService } from '../quizzes/quizzes.service';

const APP_LANGUAGE_LABELS: Record<AppLanguage, string> = {
  en: 'English',
  zh: 'Chinese',
  hi: 'Hindi',
  es: 'Spanish',
  fr: 'French',
  tr: 'Turkish',
  pt: 'Portuguese',
};

const HISTORY_WINDOW = 20;

type PreparedAttachment = {
  fileId: string;
  originalName: string;
  mimeType: string;
  size: number;
  pageCount: number | null;
  buffer: Buffer;
};

/** Reusable scalar selection for TutorConversation — keeps read paths tight. */
const conversationSelect = {
  id: true,
  userId: true,
  quizId: true,
  title: true,
  summary: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class TutorChatService {
  private readonly logger = new Logger(TutorChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly filesService: FilesService,
    private readonly billing: BillingService,
    private readonly gemini: GeminiService,
    private readonly quizzesService: QuizzesService,
  ) {}

  // -----------------------------------------------------------------------
  // Conversation CRUD
  // -----------------------------------------------------------------------

  /** List the caller's conversations, newest activity first. */
  async listConversations(userId: string, cursor?: string, limit = 20) {
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);

    const items = await this.prisma.tutorConversation.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      take: safeLimit + 1,
      skip: cursor ? 1 : 0,
      ...(cursor && { cursor: { id: cursor } }),
      select: {
        ...conversationSelect,
        quiz: { select: { id: true, title: true, subject: true } },
        _count: { select: { messages: true } },
      },
    });

    let nextCursor: string | null = null;
    if (items.length > safeLimit) {
      const overflow = items.pop();
      nextCursor = overflow?.id ?? null;
    }

    return { conversations: items, nextCursor };
  }

  /** Fetch a single conversation (metadata only). Throws 404 if missing. */
  async getConversation(userId: string, conversationId: string) {
    const conversation = await this.prisma.tutorConversation.findFirst({
      where: { id: conversationId, userId },
      select: {
        ...conversationSelect,
        quiz: { select: { id: true, title: true, subject: true } },
      },
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    return conversation;
  }

  /** Paginated message history for a conversation, oldest→newest within the page. */
  async getMessages(
    userId: string,
    conversationId: string,
    cursor?: string,
    limit = 20,
  ) {
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);

    // Verify ownership up front — cheap query, avoids leaking other users' IDs.
    const conversation = await this.prisma.tutorConversation.findFirst({
      where: { id: conversationId, userId },
      select: { id: true },
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    const messages = await this.prisma.tutorMessage.findMany({
      where: { conversationId },
      take: safeLimit + 1,
      skip: cursor ? 1 : 0,
      ...(cursor && { cursor: { id: cursor } }),
      orderBy: { createdAt: 'desc' },
      include: {
        attachments: {
          select: {
            id: true,
            fileId: true,
            originalName: true,
            mimeType: true,
            size: true,
            pageCount: true,
          },
        },
      },
    });

    let nextCursor: string | null = null;
    if (messages.length > safeLimit) {
      const overflow = messages.pop();
      nextCursor = overflow?.id ?? null;
    }

    return {
      messages: messages.reverse(),
      nextCursor,
    };
  }

  /** Rename a conversation. */
  async updateConversation(
    userId: string,
    conversationId: string,
    data: { title?: string },
  ) {
    const owned = await this.prisma.tutorConversation.findFirst({
      where: { id: conversationId, userId },
      select: { id: true },
    });
    if (!owned) {
      throw new NotFoundException('Conversation not found');
    }

    return this.prisma.tutorConversation.update({
      where: { id: conversationId },
      data: {
        title: data.title?.trim() || null,
      },
      select: conversationSelect,
    });
  }

  /** Delete a conversation (messages + attachments cascade). */
  async deleteConversation(userId: string, conversationId: string) {
    const owned = await this.prisma.tutorConversation.findFirst({
      where: { id: conversationId, userId },
      select: { id: true },
    });
    if (!owned) {
      // Idempotent: treat missing as success so retries stay clean.
      return { success: true };
    }

    await this.prisma.tutorConversation.delete({ where: { id: conversationId } });
    return { success: true };
  }

  // -----------------------------------------------------------------------
  // Send message (the main entry point)
  // -----------------------------------------------------------------------

  /**
   * Send a tutor message. Handles creating a new conversation on the fly when
   * `conversationId` is omitted, attaching PDFs/images, credit accounting,
   * and Gemini interaction.
   */
  async sendMessage(
    userId: string,
    input: {
      conversationId?: string;
      quizId?: string;
      text?: string;
      fileIds?: string[];
    },
  ) {
    const trimmedText = String(input.text || '').trim();
    const uniqueFileIds = Array.from(
      new Set((input.fileIds || []).filter((id): id is string => !!id)),
    );

    if (!trimmedText && uniqueFileIds.length === 0) {
      throw new BadRequestException('Tutor message requires text or at least one attachment.');
    }

    // 1. Resolve the conversation FIRST so ownership checks fail loudly before
    //    we do any expensive R2/Gemini work.
    const conversation = await this.resolveOrCreateConversation(userId, {
      conversationId: input.conversationId,
      quizId: input.quizId,
      firstText: trimmedText,
    });

    // 2. Load all attachments up front (parallel) so we can compute an
    //    accurate cost before charging or hitting Gemini.
    const preparedAttachments = await Promise.all(
      uniqueFileIds.map((fileId) => this.prepareAttachment(userId, fileId)),
    );

    // 3. Compute the incremental cost (base + per-attachment).
    const creditCost = this.calculateCreditCost(preparedAttachments);
    const creditSummary = await this.billing.getCreditSummary(userId);

    if (!creditSummary.isUnlimited && creditSummary.remainingCredits < creditCost) {
      return {
        status: 'credits_needed' as const,
        requiredCredits: creditCost,
        remainingCredits: creditSummary.remainingCredits,
        monthlyCredits: creditSummary.monthlyCredits,
      };
    }

    // 4. Persist the user turn (text + attachment metadata) atomically.
    const userMessage = await this.prisma.tutorMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'user',
        text: trimmedText || '(attachment)',
        attachments: preparedAttachments.length
          ? {
              create: preparedAttachments.map((att) => ({
                fileId: att.fileId,
                originalName: att.originalName,
                mimeType: att.mimeType,
                size: att.size,
                pageCount: att.pageCount,
              })),
            }
          : undefined,
      },
      include: {
        attachments: {
          select: {
            id: true,
            fileId: true,
            originalName: true,
            mimeType: true,
            size: true,
            pageCount: true,
          },
        },
      },
    });

    // 5. Upload current-turn attachments to Gemini File API (parallel).
    //    Only the CURRENT turn is uploaded — past-turn files stay text-only in
    //    history to avoid re-uploading and re-charging on every follow-up.
    const uploadedGeminiFiles: Array<{
      name: string;
      uri: string;
      mimeType: string;
      originalName: string;
    }> = [];
    const tempPaths: string[] = [];

    try {
      if (preparedAttachments.length) {
        await Promise.all(
          preparedAttachments.map(async (att) => {
            const tempPath = path.join(
              os.tmpdir(),
              `${Date.now()}-tutor-${att.fileId}-${att.originalName}`,
            );
            fs.writeFileSync(tempPath, att.buffer);
            tempPaths.push(tempPath);

            const uploaded = await this.gemini.uploadFile({
              file: tempPath,
              config: { mimeType: att.mimeType, displayName: att.originalName },
            });

            uploadedGeminiFiles.push({
              name: uploaded.name,
              uri: uploaded.uri,
              mimeType: att.mimeType,
              originalName: att.originalName,
            });
          }),
        );
      }

      const generationLanguage = await this.getUserPreferredLanguage(userId);

      // 6. Optional deck analytics context
      const analytics = conversation.quizId
        ? await this.quizzesService
            .getDeckAnalytics(userId, conversation.quizId)
            .catch((err) => {
              // Deck deleted or access revoked mid-conversation: log & continue
              // as a general chat rather than 500ing the whole request.
              this.logger.warn(
                `Deck analytics unavailable for conversation ${conversation.id}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
              return null;
            })
        : null;

      // 7. Build the system instruction
      const systemInstruction = this.buildSystemInstruction(analytics, generationLanguage);

      // 8. Fetch prior messages (exclude the just-created user turn — we
      //    build that explicitly below with `fileData` parts).
      const recentMessages = await this.prisma.tutorMessage.findMany({
        where: {
          conversationId: conversation.id,
          id: { not: userMessage.id },
        },
        orderBy: { createdAt: 'desc' },
        take: HISTORY_WINDOW,
        include: {
          attachments: {
            select: {
              originalName: true,
              mimeType: true,
              pageCount: true,
            },
          },
        },
      });

      // 9. Render history in Gemini's expected shape. Past attachments become
      //    text notes; we intentionally do NOT re-upload them.
      const historyContents = recentMessages.reverse().map((m) => {
        const note = this.buildHistoricalAttachmentNote(m.attachments);
        const combined = note ? `${note}\n\n${m.text}` : m.text;
        return {
          role: (m.role === 'assistant' ? 'model' : 'user') as 'user' | 'model',
          parts: [{ text: combined }],
        };
      });

      // 10. Current turn: file parts first, then text.
      const currentUserParts: Array<Record<string, unknown>> = [];
      for (const uploaded of uploadedGeminiFiles) {
        currentUserParts.push({
          fileData: { mimeType: uploaded.mimeType, fileUri: uploaded.uri },
        });
      }
      currentUserParts.push({
        text: trimmedText || 'Please analyze the attached materials.',
      });

      const contents = [
        ...historyContents,
        { role: 'user' as const, parts: currentUserParts },
      ];

      // 11. Call Gemini
      const response = await this.gemini.generateContent({
        contents,
        config: { systemInstruction },
      });

      const aiReplyText = String(response.text || '').trim();
      if (!aiReplyText) {
        throw new InternalServerErrorException('Tutor AI returned an empty response.');
      }

      // 12. Persist the assistant turn + bump the conversation's updatedAt
      //     (used for sorting the sidebar).
      const [assistantMessage] = await this.prisma.$transaction([
        this.prisma.tutorMessage.create({
          data: {
            conversationId: conversation.id,
            role: 'assistant',
            text: aiReplyText,
          },
          select: {
            id: true,
            role: true,
            text: true,
            createdAt: true,
          },
        }),
        this.prisma.tutorConversation.update({
          where: { id: conversation.id },
          data: { updatedAt: new Date() },
          select: { id: true },
        }),
      ]);

      // 13. Charge credits only on success
      await this.billing.consumeCredits(userId, creditCost, 'Tutor chat');

      return {
        status: 'ok' as const,
        conversationId: conversation.id,
        conversation: {
          id: conversation.id,
          title: conversation.title,
          quizId: conversation.quizId,
        },
        userMessage: {
          id: userMessage.id,
          role: userMessage.role,
          text: userMessage.text,
          createdAt: userMessage.createdAt,
          attachments: userMessage.attachments,
        },
        assistantMessage,
        reply: aiReplyText,
        creditsCharged: creditCost,
      };
    } finally {
      // Local temp files: delete synchronously (small footprint).
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
      // Gemini deletes: fire-and-forget (files auto-expire at 48h anyway).
      this.cleanupGeminiFilesInBackground(uploadedGeminiFiles.map((f) => f.name));
    }
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /**
   * Look up the conversation by ID (must belong to the caller) or create a
   * new one. Verifies deck access when `quizId` is provided.
   */
  private async resolveOrCreateConversation(
    userId: string,
    input: { conversationId?: string; quizId?: string; firstText: string },
  ) {
    if (input.conversationId) {
      const existing = await this.prisma.tutorConversation.findFirst({
        where: { id: input.conversationId, userId },
        select: conversationSelect,
      });
      if (!existing) {
        throw new NotFoundException('Conversation not found');
      }

      // Allow linking a deck later if the conversation didn't have one and
      // the caller now provided one. We do NOT overwrite an existing deck.
      if (input.quizId && !existing.quizId) {
        await this.assertDeckAccessible(userId, input.quizId);
        return this.prisma.tutorConversation.update({
          where: { id: existing.id },
          data: { quizId: input.quizId },
          select: conversationSelect,
        });
      }

      return existing;
    }

    // New conversation
    if (input.quizId) {
      await this.assertDeckAccessible(userId, input.quizId);
    }

    return this.prisma.tutorConversation.create({
      data: {
        userId,
        quizId: input.quizId ?? null,
        title: this.deriveTitle(input.firstText),
      },
      select: conversationSelect,
    });
  }

  /** Confirms the user can read the deck (owner / saver / public). */
  private async assertDeckAccessible(userId: string, quizId: string) {
    const deck = await this.prisma.generatedQuiz.findFirst({
      where: {
        id: quizId,
        OR: [
          { userId },
          { saves: { some: { userId } } },
          { isPublic: true },
        ],
      },
      select: { id: true },
    });

    if (!deck) {
      throw new ForbiddenException('Deck not found or not accessible');
    }
  }

  /** Short human-readable title derived from the first user message. */
  private deriveTitle(text: string): string | null {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (!cleaned) return null;
    return cleaned.length > 60 ? `${cleaned.slice(0, 57)}…` : cleaned;
  }

  /**
   * Base TUTOR_CHAT_MESSAGE cost + IMAGE_UPLOAD per image + PDF_PAGE per page
   * (rounded via calculateCreditsForUnits).
   */
  private calculateCreditCost(
    attachments: Array<{ mimeType: string; pageCount?: number | null }>,
  ) {
    let total = calculateCreditsForUnits(CreditCostType.TUTOR_CHAT_MESSAGE, 1);

    for (const attachment of attachments) {
      const mime = String(attachment.mimeType || '').toLowerCase();
      if (mime === 'application/pdf') {
        const pages = Math.max(1, Number(attachment.pageCount || 1));
        total += calculateCreditsForUnits(CreditCostType.PDF_PAGE, pages);
      } else if (mime.startsWith('image/')) {
        total += calculateCreditsForUnits(CreditCostType.IMAGE_UPLOAD, 1);
      } else {
        // Unknown types are conservative — bill as an image.
        total += calculateCreditsForUnits(CreditCostType.IMAGE_UPLOAD, 1);
      }
    }

    return total;
  }

  /**
   * Load an attachment from R2, detect page count for PDFs, and return the
   * buffer + metadata ready for both DB persistence and Gemini upload.
   */
  private async prepareAttachment(userId: string, fileId: string): Promise<PreparedAttachment> {
    const file = await this.prisma.uploadedFile.findFirst({
      where: { id: fileId, userId },
      select: {
        id: true,
        r2Key: true,
        mimeType: true,
        originalName: true,
        size: true,
      },
    });

    if (!file) {
      throw new NotFoundException(`Attachment ${fileId} not found or not owned by user.`);
    }

    const mime = String(file.mimeType || '').toLowerCase();
    const isPdf = mime === 'application/pdf';
    const isImage = mime.startsWith('image/');

    if (!isPdf && !isImage) {
      throw new BadRequestException(
        `Attachment ${file.originalName} has unsupported type ${file.mimeType}. Only PDF and images are supported in tutor chat.`,
      );
    }

    const { buffer } = await this.filesService.getObjectBuffer(file.r2Key);

    let pageCount: number | null = null;
    if (isPdf) {
      try {
        const pdfDocument = await PDFDocument.load(buffer, { ignoreEncryption: true });
        pageCount = pdfDocument.getPageCount();
      } catch (error) {
        this.logger.warn(
          `Could not read page count for PDF ${file.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        pageCount = 1;
      }
    }

    return {
      fileId: file.id,
      originalName: file.originalName,
      mimeType: file.mimeType,
      size: file.size,
      pageCount,
      buffer,
    };
  }

  /**
   * Compact text representation of files the user shared in a PAST turn.
   * We don't re-upload the binary because Gemini's uploaded files expire
   * (48h) and re-charging the user for the same file on every follow-up
   * would be wrong. The note is enough for the model to reason about
   * "the PDF I sent earlier".
   */
  private buildHistoricalAttachmentNote(
    attachments: Array<{ originalName: string; mimeType: string; pageCount: number | null }>,
  ) {
    if (!attachments.length) return '';

    const descriptions = attachments.map((att) => {
      const mime = String(att.mimeType || '').toLowerCase();
      if (mime === 'application/pdf') {
        const pages = att.pageCount ? ` (${att.pageCount} pages)` : '';
        return `PDF "${att.originalName}"${pages}`;
      }
      if (mime.startsWith('image/')) {
        return `image "${att.originalName}"`;
      }
      return `file "${att.originalName}"`;
    });

    return `[Previously attached in this conversation: ${descriptions.join(', ')}]`;
  }

  /** Read the user's preferred UI language for tutor responses. */
  private async getUserPreferredLanguage(userId: string): Promise<AppLanguage> {
    const user = (await this.prisma.user.findUnique({
      where: { id: userId },
      select: { preferredLanguage: true } as any,
    })) as { preferredLanguage?: AppLanguage } | null;

    return user?.preferredLanguage ?? 'en';
  }

  /**
   * Build the system instruction. When deck analytics are available we
   * fold them in; otherwise we produce a leaner "general tutor" prompt.
   */
  private buildSystemInstruction(
    analytics:
      | Awaited<ReturnType<QuizzesService['getDeckAnalytics']>>
      | null,
    generationLanguage: AppLanguage,
  ) {
    const languageLine = `Language requirement: write all AI tutor interactions entirely in ${APP_LANGUAGE_LABELS[generationLanguage]}, including greetings, explanations, examples, hints, feedback, follow-up questions, learning summaries, corrections, and recommendations. Maintain a natural conversational tone in the selected language. Do not mix languages or translate content unless the user explicitly requests it.`;

    const sharedGuidelines = [
      languageLine,
      'Be warm, supportive, and use a conversational tutor tone.',
      'Default to short answers that feel like natural back-and-forth, not a report.',
      'Start with the minimum helpful answer first; usually 2-5 sentences is enough.',
      'Only give a detailed breakdown when the user asks for more detail or the situation truly requires it.',
      'When helpful, end with one simple follow-up question or one concrete next step.',
      'When the user attaches a PDF or image, ground your answer primarily in that new material.',
      'You can use emoji sparingly for friendliness.',
    ]
      .map((line) => `- ${line}`)
      .join('\n');

    // Grounding rules stop the model from inventing a topic when the user's
    // request is vague ("explain a difficult concept simply", "quiz me",
    // "help me study"). Without these the model picks a random concept
    // (classically "opportunity cost") and answers as if the user asked
    // about it — which feels dishonest and wastes credits.
    const groundingGuidelines = [
      'Ground every answer in ONE of these sources, in this priority order: (1) files attached in the CURRENT turn, (2) files referenced in prior turns of this conversation, (3) the deck analytics context if present, (4) something the user explicitly named in this or a previous message.',
      'If none of those sources tell you WHAT the user wants to discuss, do NOT invent a topic. Ask a short clarifying question instead (e.g. "Which concept from your notes should we tackle?" or "Which topic from the deck feels hardest?").',
      'Never fabricate topics, examples, statistics, quotes, page numbers, or citations. If a fact is not visible in the sources above and you are not certain, say you are not sure rather than guessing.',
      'When the user gives a generic instruction ("explain something difficult", "quiz me", "help me"), treat it as a REQUEST FOR DIRECTION, not a request to pick for them. Offer 2-3 concrete options drawn from the actual sources and let the user choose.',
      'When a deck is attached, prefer topics/questions the analytics show the user actually struggled with over topics you find interesting.',
      'If the user asks a question you genuinely cannot answer from the available context, say so plainly in one sentence — do not paper over it with plausible-sounding filler.',
      'Do not restate the analytics numbers back to the user unless they asked; use them silently to pick what to talk about.',
    ]
      .map((line) => `- ${line}`)
      .join('\n');

    // Formatting is intentionally separate so we can tune it independently of
    // tone/behavior. The client renders responses as Markdown, so the model
    // MUST emit valid Markdown (bold, italics, bullets, tables, fenced code)
    // instead of leaking raw asterisks or ad-hoc punctuation.
    const formattingGuidelines = [
      'Format every response as valid GitHub-Flavored Markdown.',
      'Use **bold** ONLY to emphasize a key term, a critical warning, or the single most important takeaway — not for whole sentences or decoration.',
      'Use *italics* for gentle emphasis, book/paper titles, or foreign terms.',
      'Use `inline code` for formulas, variable names, keyboard shortcuts, file names, and short technical strings.',
      'Use fenced ```code blocks``` with a language tag for any multi-line code, pseudocode, or command sequences.',
      'Use `-` bulleted lists for 3+ parallel items; keep each bullet to one line when possible.',
      'Use `1.` numbered lists only for genuinely ordered steps.',
      'Use Markdown tables for compact comparisons of 2+ items across 2+ attributes.',
      'Use `>` blockquotes for direct quotes from the attached material.',
      'Do NOT wrap the entire message in a code block, and do NOT include raw HTML.',
      'Do NOT use headings (# / ##) for short conversational replies; reserve them for long structured explanations the user explicitly asked for.',
    ]
      .map((line) => `- ${line}`)
      .join('\n');

    if (!analytics) {
      return `You are a friendly, encouraging AI study tutor. The student may attach PDFs or images (e.g. lecture slides, textbook pages, handwritten notes) — when they do, treat those materials as authoritative source content for that turn. There is no specific deck attached to this conversation, so respond as a general study companion.

If the student has not shared any material and has not named a topic, DO NOT pick one for them. Ask what they want to study.

Grounding:
${groundingGuidelines}

Guidelines:
${sharedGuidelines}

Formatting:
${formattingGuidelines}`;
    }

    const strugglingQuestions =
      analytics.questions
        .filter((q) => q.timesAnswered > 0 && q.timesCorrect / q.timesAnswered < 0.6)
        .map(
          (q) =>
            `  - "${q.question}" (${q.tier}, ${Math.round(
              (q.timesCorrect / q.timesAnswered) * 100,
            )}% accuracy)`,
        )
        .join('\n') || '  None — great job!';

    return `You are a friendly, encouraging AI study tutor. The student just reviewed their quiz analytics and you are here to help them understand their performance and guide them on what to focus on next. The student may also attach PDFs or images (e.g. lecture slides, textbook pages, handwritten notes) to any message — when they do, treat those materials as authoritative source content for that turn.

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
${strugglingQuestions}

Grounding:
${groundingGuidelines}

Guidelines:
${sharedGuidelines}
- Use at most 1-2 relevant stats unless the user explicitly asks for a deeper breakdown.
- Do not dump all analytics categories at once; pick the single most relevant insight or next step.
- Translate stats into plain language and focus on what the student should do next.
- If this is the first message, introduce yourself briefly, give a quick read on how they did, mention one strength and one improvement area, then stop.
- Combine attachment content with the deck analytics where relevant.

Formatting:
${formattingGuidelines}`;
  }

  /**
   * Fire-and-forget deletion of files we uploaded to the Gemini File API.
   * Errors are swallowed because the files auto-expire after 48h anyway —
   * failing here should never surface to the caller or roll back credits.
   */
  private cleanupGeminiFilesInBackground(fileNames: string[]) {
    if (!fileNames.length) return;
    void Promise.allSettled(
      fileNames.map((name) => this.gemini.deleteFile({ name }).catch(() => undefined)),
    );
  }
}
