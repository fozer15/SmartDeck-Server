-- AlterTable
ALTER TABLE "StudySessionQuestionProgress" ADD COLUMN     "lastAttemptCorrect" BOOLEAN,
ADD COLUMN     "lastCorrectAnswer" TEXT,
ADD COLUMN     "lastUserAnswer" TEXT;
