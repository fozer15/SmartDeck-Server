-- CreateEnum
CREATE TYPE "QuizGenerationJobStatus" AS ENUM ('queued', 'processing', 'completed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "QuizGenerationSourceType" AS ENUM ('files', 'audio', 'text');

-- CreateTable
CREATE TABLE "QuizGenerationJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "QuizGenerationJobStatus" NOT NULL DEFAULT 'queued',
    "sourceType" "QuizGenerationSourceType" NOT NULL,
    "payload" JSONB NOT NULL,
    "title" TEXT,
    "estimatedCredits" INTEGER NOT NULL,
    "resultQuizId" TEXT,
    "errorMessage" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuizGenerationJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuizGenerationJob_userId_createdAt_idx" ON "QuizGenerationJob"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "QuizGenerationJob_userId_status_idx" ON "QuizGenerationJob"("userId", "status");

-- CreateIndex
CREATE INDEX "QuizGenerationJob_status_createdAt_idx" ON "QuizGenerationJob"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "QuizGenerationJob" ADD CONSTRAINT "QuizGenerationJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
