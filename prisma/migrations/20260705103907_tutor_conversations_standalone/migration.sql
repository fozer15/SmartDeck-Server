-- DropForeignKey
ALTER TABLE "TutorConversation" DROP CONSTRAINT "TutorConversation_quizId_fkey";

-- DropIndex
DROP INDEX "TutorConversation_userId_quizId_key";

-- AlterTable
ALTER TABLE "TutorConversation" ADD COLUMN     "title" TEXT,
ALTER COLUMN "quizId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "TutorConversation_userId_updatedAt_idx" ON "TutorConversation"("userId", "updatedAt");

-- AddForeignKey
ALTER TABLE "TutorConversation" ADD CONSTRAINT "TutorConversation_quizId_fkey" FOREIGN KEY ("quizId") REFERENCES "GeneratedQuiz"("id") ON DELETE SET NULL ON UPDATE CASCADE;
