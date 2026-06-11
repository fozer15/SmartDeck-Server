-- Add the consolidated credit counter.
ALTER TABLE "UserUsageLimit"
ADD COLUMN "creditsUsed" INTEGER NOT NULL DEFAULT 0;

-- Convert existing metric-based usage into the new credit ledger.
UPDATE "UserUsageLimit"
SET "creditsUsed" =
  CEIL("pdfPagesUsed" / 2.0)::INTEGER +
  (COALESCE("audioMinutesUsed", 0) * 2) +
  (COALESCE("aiCreditsUsed", 0) * 15) +
  (COALESCE("imageUsed", 0) * 8) +
  (COALESCE("tutorChatUsed", 0) * 3) +
  CEIL(COALESCE("textCharacterUsed", 0) / 2000.0)::INTEGER;

-- Remove legacy metric-specific counters.
ALTER TABLE "UserUsageLimit"
DROP COLUMN "pdfPagesUsed",
DROP COLUMN "audioMinutesUsed",
DROP COLUMN "aiCreditsUsed",
DROP COLUMN "imageUsed",
DROP COLUMN "tutorChatUsed",
DROP COLUMN "textCharacterUsed";
