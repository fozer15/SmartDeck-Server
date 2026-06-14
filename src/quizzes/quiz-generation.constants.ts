export const QUIZ_GENERATION_QUEUE_NAME = 'quiz-generation';
export const QUIZ_GENERATION_JOB_NAME = 'generate-quiz';

export type QuizGenerationQueueData = {
  generationJobId: string;
};