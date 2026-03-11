import { z } from 'zod';

export const quizQuestionSchema = z.object({
  question: z.string().describe('The quiz question text'),
  options: z.array(z.string()).length(4).describe('Four multiple choice options'),
  correctAnswer: z.string().describe('The correct answer from the options'),
  explanation: z.string().describe('Brief explanation of why this answer is correct'),
  tier: z
    .enum(['recall', 'application', 'analysis'])
    .describe(
      "Bloom's Taxonomy tier: recall=basic memorization, application=using concepts in a scenario, analysis=connecting multiple concepts or evaluating tradeoffs",
    ),
  topic: z.string().describe('The main topic or concept this question covers'),
});

export const quizResponseSchema = z.object({
  quizzes: z.array(quizQuestionSchema).describe('Array of quiz questions'),
  rigorIndex: z
    .number()
    .min(0)
    .max(100)
    .describe(
      "Weighted score 0-100 based on Bloom's Taxonomy tiers. Recall-only=~30, balanced mix=~60, heavy analysis/application=85-100",
    ),
});

export type QuizResponse = z.infer<typeof quizResponseSchema>;
