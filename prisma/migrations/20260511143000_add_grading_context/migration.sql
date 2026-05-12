ALTER TABLE "GeneratedQuiz"
ADD COLUMN "gradingContext" TEXT;

ALTER TABLE "QuizQuestion"
ADD COLUMN "gradingContext" TEXT;