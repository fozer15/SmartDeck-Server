-- CreateEnum
CREATE TYPE "SolveJobStatus" AS ENUM ('queued', 'processing', 'completed', 'failed', 'cancelled');

-- CreateTable
CREATE TABLE "SolveJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "SolveJobStatus" NOT NULL DEFAULT 'queued',
    "payload" JSONB NOT NULL,
    "result" TEXT,
    "errorMessage" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SolveJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SolveJob_userId_createdAt_idx" ON "SolveJob"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "SolveJob_userId_status_idx" ON "SolveJob"("userId", "status");

-- CreateIndex
CREATE INDEX "SolveJob_status_createdAt_idx" ON "SolveJob"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "SolveJob" ADD CONSTRAINT "SolveJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
