/*
  Warnings:

  - You are about to drop the column `payload` on the `SolveJob` table. All the data in the column will be lost.
  - You are about to drop the column `result` on the `SolveJob` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[resultSolutionId]` on the table `SolveJob` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "SolveJob" DROP COLUMN "payload",
DROP COLUMN "result",
ADD COLUMN     "note" TEXT,
ADD COLUMN     "resultSolutionId" TEXT;

-- CreateTable
CREATE TABLE "GeneratedSolution" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GeneratedSolution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_SolveJobSourceFiles" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "_GeneratedSolutionSourceFiles" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "GeneratedSolution_userId_createdAt_idx" ON "GeneratedSolution"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "_SolveJobSourceFiles_AB_unique" ON "_SolveJobSourceFiles"("A", "B");

-- CreateIndex
CREATE INDEX "_SolveJobSourceFiles_B_index" ON "_SolveJobSourceFiles"("B");

-- CreateIndex
CREATE UNIQUE INDEX "_GeneratedSolutionSourceFiles_AB_unique" ON "_GeneratedSolutionSourceFiles"("A", "B");

-- CreateIndex
CREATE INDEX "_GeneratedSolutionSourceFiles_B_index" ON "_GeneratedSolutionSourceFiles"("B");

-- CreateIndex
CREATE UNIQUE INDEX "SolveJob_resultSolutionId_key" ON "SolveJob"("resultSolutionId");

-- AddForeignKey
ALTER TABLE "SolveJob" ADD CONSTRAINT "SolveJob_resultSolutionId_fkey" FOREIGN KEY ("resultSolutionId") REFERENCES "GeneratedSolution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeneratedSolution" ADD CONSTRAINT "GeneratedSolution_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_SolveJobSourceFiles" ADD CONSTRAINT "_SolveJobSourceFiles_A_fkey" FOREIGN KEY ("A") REFERENCES "SolveJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_SolveJobSourceFiles" ADD CONSTRAINT "_SolveJobSourceFiles_B_fkey" FOREIGN KEY ("B") REFERENCES "UploadedFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_GeneratedSolutionSourceFiles" ADD CONSTRAINT "_GeneratedSolutionSourceFiles_A_fkey" FOREIGN KEY ("A") REFERENCES "GeneratedSolution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_GeneratedSolutionSourceFiles" ADD CONSTRAINT "_GeneratedSolutionSourceFiles_B_fkey" FOREIGN KEY ("B") REFERENCES "UploadedFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
