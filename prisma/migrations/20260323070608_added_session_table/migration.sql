/*
  Warnings:

  - Added the required column `updatedAt` to the `GeneratedQuiz` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "QuestionFormat" AS ENUM ('multiple_choice', 'flashcard', 'short_answer');

-- AlterTable
ALTER TABLE "GeneratedQuiz" ADD COLUMN     "isPublic" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "subject" TEXT,
ADD COLUMN     "title" TEXT NOT NULL DEFAULT 'Untitled Deck',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "QuizQuestion" ADD COLUMN     "format" "QuestionFormat" NOT NULL DEFAULT 'multiple_choice',
ALTER COLUMN "explanation" DROP NOT NULL,
ALTER COLUMN "topic" DROP NOT NULL;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "globalStreak" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastActive" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "StudySession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "quizId" TEXT NOT NULL,
    "questionQueue" TEXT[],
    "currentIndex" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudySession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StudySession_userId_idx" ON "StudySession"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "StudySession_userId_quizId_key" ON "StudySession"("userId", "quizId");

-- AddForeignKey
ALTER TABLE "StudySession" ADD CONSTRAINT "StudySession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudySession" ADD CONSTRAINT "StudySession_quizId_fkey" FOREIGN KEY ("quizId") REFERENCES "GeneratedQuiz"("id") ON DELETE CASCADE ON UPDATE CASCADE;
