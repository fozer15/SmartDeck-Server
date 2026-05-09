UPDATE "GeneratedQuiz"
SET "subject" = 'GENERAL_STUDIES'
WHERE "subject" IS NULL;

ALTER TABLE "GeneratedQuiz"
ALTER COLUMN "subject" SET NOT NULL;
