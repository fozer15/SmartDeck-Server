/*
  Warnings:

  - You are about to drop the `_GeneratedQuizToUploadedFile` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "_GeneratedQuizToUploadedFile" DROP CONSTRAINT "_GeneratedQuizToUploadedFile_A_fkey";

-- DropForeignKey
ALTER TABLE "_GeneratedQuizToUploadedFile" DROP CONSTRAINT "_GeneratedQuizToUploadedFile_B_fkey";

-- DropTable
DROP TABLE "_GeneratedQuizToUploadedFile";

-- CreateTable
CREATE TABLE "QuizFile" (
    "id" TEXT NOT NULL,
    "quizId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuizFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuizFile_quizId_idx" ON "QuizFile"("quizId");

-- CreateIndex
CREATE INDEX "QuizFile_fileId_idx" ON "QuizFile"("fileId");

-- CreateIndex
CREATE UNIQUE INDEX "QuizFile_quizId_fileId_key" ON "QuizFile"("quizId", "fileId");

-- AddForeignKey
ALTER TABLE "QuizFile" ADD CONSTRAINT "QuizFile_quizId_fkey" FOREIGN KEY ("quizId") REFERENCES "GeneratedQuiz"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizFile" ADD CONSTRAINT "QuizFile_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "UploadedFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
