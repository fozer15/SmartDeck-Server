CREATE TYPE "AppLanguage" AS ENUM ('en', 'zh', 'hi', 'es', 'fr');

ALTER TABLE "User"
ADD COLUMN "preferredLanguage" "AppLanguage" NOT NULL DEFAULT 'en';

ALTER TABLE "GeneratedQuiz"
ADD COLUMN "language" "AppLanguage" NOT NULL DEFAULT 'en';