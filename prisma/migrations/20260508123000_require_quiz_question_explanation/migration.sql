UPDATE "QuizQuestion"
SET "explanation" = CASE
  WHEN "format" = 'flashcard' AND COALESCE(BTRIM("question"), '') <> '' AND COALESCE(BTRIM("correctAnswer"), '') <> ''
    THEN 'This flashcard links "' || REPLACE("question", '"', '''') || '" to "' || REPLACE("correctAnswer", '"', '''') || '" as the key idea to remember.'
  WHEN "format" = 'flashcard' AND COALESCE(BTRIM("correctAnswer"), '') <> ''
    THEN 'The key concept to remember is "' || REPLACE("correctAnswer", '"', '''') || '".'
  WHEN "format" = 'flashcard'
    THEN 'This flashcard reinforces the key concept from the source material.'
  WHEN "format" = 'short_answer' AND COALESCE(BTRIM("correctAnswer"), '') <> ''
    THEN 'The expected answer is "' || REPLACE("correctAnswer", '"', '''') || '" based on the source material.'
  WHEN "format" = 'short_answer'
    THEN 'The expected answer follows directly from the source material.'
  WHEN COALESCE(BTRIM("correctAnswer"), '') <> ''
    THEN 'The correct answer is "' || REPLACE("correctAnswer", '"', '''') || '" because it best matches the source material.'
  ELSE 'This answer is correct based on the source material.'
END
WHERE "explanation" IS NULL OR BTRIM("explanation") = '';

ALTER TABLE "QuizQuestion"
ALTER COLUMN "explanation" SET NOT NULL;
