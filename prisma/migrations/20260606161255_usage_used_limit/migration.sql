-- CreateTable
CREATE TABLE "UserUsageLimit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "pdfPagesUsed" INTEGER NOT NULL DEFAULT 0,
    "audioMinutesUsed" INTEGER NOT NULL DEFAULT 0,
    "aiCreditsUsed" INTEGER NOT NULL DEFAULT 0,
    "imageUsed" INTEGER NOT NULL DEFAULT 0,
    "tutorChatUsed" INTEGER NOT NULL DEFAULT 0,
    "textCharacterUsed" INTEGER NOT NULL DEFAULT 0,
    "lastResetDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserUsageLimit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserUsageLimit_userId_key" ON "UserUsageLimit"("userId");

-- CreateIndex
CREATE INDEX "UserUsageLimit_userId_idx" ON "UserUsageLimit"("userId");

-- AddForeignKey
ALTER TABLE "UserUsageLimit" ADD CONSTRAINT "UserUsageLimit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
