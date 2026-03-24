-- CreateEnum
CREATE TYPE "QuizTierPreference" AS ENUM ('recall', 'application', 'analysis', 'mixed');

-- CreateEnum
CREATE TYPE "QuizFormatPreference" AS ENUM ('multiple_choice', 'flashcard', 'short_answer', 'mixed');

-- AlterTable
ALTER TABLE "GeneratedQuiz" ADD COLUMN     "questionCount" INTEGER,
ADD COLUMN     "questionFormat" "QuizFormatPreference",
ADD COLUMN     "questionTier" "QuizTierPreference";
