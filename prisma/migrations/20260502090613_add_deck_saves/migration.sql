-- CreateTable
CREATE TABLE "DeckSave" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deckId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeckSave_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeckSave_userId_idx" ON "DeckSave"("userId");

-- CreateIndex
CREATE INDEX "DeckSave_deckId_idx" ON "DeckSave"("deckId");

-- CreateIndex
CREATE UNIQUE INDEX "DeckSave_userId_deckId_key" ON "DeckSave"("userId", "deckId");

-- AddForeignKey
ALTER TABLE "DeckSave" ADD CONSTRAINT "DeckSave_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeckSave" ADD CONSTRAINT "DeckSave_deckId_fkey" FOREIGN KEY ("deckId") REFERENCES "GeneratedQuiz"("id") ON DELETE CASCADE ON UPDATE CASCADE;
