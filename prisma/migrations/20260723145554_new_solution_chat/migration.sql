-- CreateTable
CREATE TABLE "SolutionMessage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "solutionId" TEXT NOT NULL,
    "role" "TutorRole" NOT NULL DEFAULT 'user',
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SolutionMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SolutionMessage_solutionId_createdAt_idx" ON "SolutionMessage"("solutionId", "createdAt");

-- CreateIndex
CREATE INDEX "SolutionMessage_userId_idx" ON "SolutionMessage"("userId");

-- AddForeignKey
ALTER TABLE "SolutionMessage" ADD CONSTRAINT "SolutionMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolutionMessage" ADD CONSTRAINT "SolutionMessage_solutionId_fkey" FOREIGN KEY ("solutionId") REFERENCES "GeneratedSolution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
