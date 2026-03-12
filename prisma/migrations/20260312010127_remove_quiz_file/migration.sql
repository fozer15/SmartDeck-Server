/*
  Warnings:

  - You are about to drop the `QuizFile` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "QuizFile" DROP CONSTRAINT "QuizFile_fileId_fkey";

-- DropForeignKey
ALTER TABLE "QuizFile" DROP CONSTRAINT "QuizFile_quizId_fkey";

-- AlterTable
ALTER TABLE "QuizQuestion" ADD COLUMN     "lastReviewed" TIMESTAMP(3),
ADD COLUMN     "streak" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "timesAnswered" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "timesCorrect" INTEGER NOT NULL DEFAULT 0;

-- DropTable
DROP TABLE "QuizFile";

-- CreateTable
CREATE TABLE "_GeneratedQuizToUploadedFile" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "_GeneratedQuizToUploadedFile_AB_unique" ON "_GeneratedQuizToUploadedFile"("A", "B");

-- CreateIndex
CREATE INDEX "_GeneratedQuizToUploadedFile_B_index" ON "_GeneratedQuizToUploadedFile"("B");

-- AddForeignKey
ALTER TABLE "_GeneratedQuizToUploadedFile" ADD CONSTRAINT "_GeneratedQuizToUploadedFile_A_fkey" FOREIGN KEY ("A") REFERENCES "GeneratedQuiz"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_GeneratedQuizToUploadedFile" ADD CONSTRAINT "_GeneratedQuizToUploadedFile_B_fkey" FOREIGN KEY ("B") REFERENCES "UploadedFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
