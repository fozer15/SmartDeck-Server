-- CreateTable
CREATE TABLE "TutorMessageAttachment" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "pageCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TutorMessageAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TutorMessageAttachment_messageId_idx" ON "TutorMessageAttachment"("messageId");

-- CreateIndex
CREATE INDEX "TutorMessageAttachment_fileId_idx" ON "TutorMessageAttachment"("fileId");

-- AddForeignKey
ALTER TABLE "TutorMessageAttachment" ADD CONSTRAINT "TutorMessageAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "TutorMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TutorMessageAttachment" ADD CONSTRAINT "TutorMessageAttachment_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "UploadedFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
