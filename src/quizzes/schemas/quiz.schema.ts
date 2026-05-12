import { z } from 'zod';

const questionMetaSchema = z.object({
  tier: z
    .enum(['recall', 'application', 'analysis'])
    .describe(
      "Bloom's Taxonomy tier: recall=basic memorization, application=using concepts in a scenario, analysis=connecting multiple concepts or evaluating tradeoffs",
    ),
  topic: z.string().describe('The main topic or concept this question covers'),
  explanation: z.string().trim().min(1).describe('Brief explanation, teaching note, or rationale for the answer'),
  gradingContext: z
    .string()
    .trim()
    .min(1)
    .describe('Question-specific grading context: the key facts, acceptable paraphrases, and core reasoning needed to grade this question'),
});

const multipleChoiceQuestionSchema = questionMetaSchema.extend({
  format: z.literal('multiple_choice').describe('Multiple-choice question with selectable options'),
  question: z.string().describe('The quiz question text'),
  options: z.array(z.string()).length(4).describe('Exactly four options for multiple choice'),
  correctAnswer: z.string().describe('The correct option text'),
});

const flashcardQuestionSchema = questionMetaSchema.extend({
  format: z.literal('flashcard').describe('Flashcard style prompt and answer'),
  question: z.string().describe('Front side prompt of the flashcard'),
  correctAnswer: z.string().describe('Back side answer of the flashcard'),
});

const shortAnswerQuestionSchema = questionMetaSchema.extend({
  format: z.literal('short_answer').describe('Short-answer question with expected answer'),
  question: z.string().describe('The short-answer question text'),
  correctAnswer: z.string().describe('Expected short answer (or canonical answer)'),
});

export const quizQuestionSchema = z.discriminatedUnion('format', [
  multipleChoiceQuestionSchema,
  flashcardQuestionSchema,
  shortAnswerQuestionSchema,
]);

export const quizResponseSchema = z.object({
  quizzes: z.array(quizQuestionSchema).describe('Array of quiz questions'),
  gradingContext: z
    .string()
    .trim()
    .min(1)
    .describe('Deck-level grading context summarizing the core concepts, acceptable wording variations, and overall grading guidance for the deck'),
  rigorIndex: z
    .number()
    .min(0)
    .max(100)
    .describe(
      "Weighted score 0-100 based on Bloom's Taxonomy tiers. Recall-only=~30, balanced mix=~60, heavy analysis/application=85-100",
    ),
});

export type QuizResponse = z.infer<typeof quizResponseSchema>;
