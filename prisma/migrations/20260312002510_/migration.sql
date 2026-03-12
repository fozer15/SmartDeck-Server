/*
  Warnings:

  - You are about to drop the `Account` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `QuizFile` table. If the table is not empty, all the data it contains will be lost.
  - Changed the type of `tier` on the `QuizQuestion` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Made the column `email` on table `User` required. This step will fail if there are existing NULL values in that column.

*/
-- CreateEnum
CREATE TYPE "QuestionTier" AS ENUM ('recall', 'application', 'analysis');

-- DropForeignKey
ALTER TABLE "Account" DROP CONSTRAINT "Account_userId_fkey";

-- DropForeignKey
ALTER TABLE "QuizFile" DROP CONSTRAINT "QuizFile_fileId_fkey";

-- DropForeignKey
ALTER TABLE "QuizFile" DROP CONSTRAINT "QuizFile_quizId_fkey";

-- AlterTable
ALTER TABLE "QuizQuestion" DROP COLUMN "tier",
ADD COLUMN     "tier" "QuestionTier" NOT NULL;

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "email" SET NOT NULL;

-- DropTable
DROP TABLE "Account";

-- DropTable
DROP TABLE "QuizFile";

-- DropEnum
DROP TYPE "AuthProvider";

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
