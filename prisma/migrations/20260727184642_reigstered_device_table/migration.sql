-- CreateTable
CREATE TABLE "RegisteredDevice" (
    "deviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegisteredDevice_pkey" PRIMARY KEY ("deviceId")
);

-- CreateIndex
CREATE INDEX "RegisteredDevice_createdAt_idx" ON "RegisteredDevice"("createdAt");
