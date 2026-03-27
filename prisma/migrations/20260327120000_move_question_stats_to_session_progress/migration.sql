-- CreateTable
CREATE TABLE "StudySessionQuestionProgress" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "timesAnswered" INTEGER NOT NULL DEFAULT 0,
    "timesCorrect" INTEGER NOT NULL DEFAULT 0,
    "streak" INTEGER NOT NULL DEFAULT 0,
    "lastReviewed" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudySessionQuestionProgress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StudySessionQuestionProgress_sessionId_questionId_key" ON "StudySessionQuestionProgress"("sessionId", "questionId");

-- CreateIndex
CREATE INDEX "StudySessionQuestionProgress_sessionId_idx" ON "StudySessionQuestionProgress"("sessionId");

-- CreateIndex
CREATE INDEX "StudySessionQuestionProgress_questionId_idx" ON "StudySessionQuestionProgress"("questionId");

-- AddForeignKey
ALTER TABLE "StudySessionQuestionProgress" ADD CONSTRAINT "StudySessionQuestionProgress_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "StudySession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudySessionQuestionProgress" ADD CONSTRAINT "StudySessionQuestionProgress_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "QuizQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "QuizQuestion"
    DROP COLUMN "timesAnswered",
    DROP COLUMN "timesCorrect",
    DROP COLUMN "streak",
    DROP COLUMN "lastReviewed";
