import { ForbiddenException, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EnvService } from '../env/env.service';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'stream';
import { PDFDocument } from 'pdf-lib';
import { BillingService } from '../billing/billing.service';
import { CreditCostType, calculateCreditsForUnits } from '../config/plan-limits';
import { parseBuffer } from 'music-metadata';

@Injectable()
export class FilesService {
  private s3: S3Client;
  private bucketName: string;
  private readonly signedViewUrlTtlSeconds = 300;
  private readonly appBaseUrl: string;

  constructor(
    private prisma: PrismaService,
    private env: EnvService,
    private billing: BillingService,
  ) {
    this.s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${env.r2AccountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.r2AccessKeyId,
        secretAccessKey: env.r2SecretAccessKey,
      },
    });
    this.bucketName = env.r2BucketName;
    this.appBaseUrl = env.appBaseUrl;
  }

  async upload(userId: string, file: Express.Multer.File) {
    const safeFileName = this.toStorageSafeFileName(file.originalname);
    const r2Key = `uploads/${userId}/files/${Date.now()}-${safeFileName}`;
    const uploadCreditCost = await this.calculateUploadCreditCost(file, safeFileName);

    if (uploadCreditCost > 0) {
      const affordability = await this.billing.canAffordCredits(userId, uploadCreditCost);
      if (!affordability.canAfford) {
        return {
          status: 'credits_needed',
          requiredCredits: uploadCreditCost,
          remainingCredits: affordability.remainingCredits,
          monthlyCredits: affordability.monthlyCredits,
        };
      }
    }

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: r2Key,
        Body: file.buffer,
        ContentType: file.mimetype,
      }),
    );

    const createdFile = await this.prisma.uploadedFile.create({
      data: {
        userId,
        originalName: safeFileName,
        r2Key,
        mimeType: file.mimetype,
        size: file.size,
      },
    });

    if (uploadCreditCost > 0) {
      try {
        await this.billing.consumeCredits(userId, uploadCreditCost, 'File upload');
      } catch (error) {
        await this.deleteFile(createdFile.id).catch(() => {});
        throw error;
      }
    }

    return createdFile;
  }

  private async calculateUploadCreditCost(file: Express.Multer.File, safeFileName: string): Promise<number> {
    if (file.mimetype === 'application/pdf') {
      try {
        const pdfDoc = await PDFDocument.load(file.buffer);
        return calculateCreditsForUnits(CreditCostType.PDF_PAGE, pdfDoc.getPageCount());
      } catch (error) {
        throw new BadRequestException(`Could not parse PDF file: ${safeFileName}. The file may be corrupt.`);
      }
    }

    if (file.mimetype.startsWith('audio/')) {
      try {
        const metadata = await parseBuffer(file.buffer, { mimeType: file.mimetype });
        if (!metadata.format.duration) {
          throw new Error('No duration found');
        }

        const durationInMinutes = Math.max(1, Math.ceil(metadata.format.duration / 60));
        return calculateCreditsForUnits(CreditCostType.AUDIO_MINUTE, durationInMinutes);
      } catch (error) {
        throw new BadRequestException(`Could not read audio duration for: ${safeFileName}. Unrecognized or corrupt format.`);
      }
    }

    if (file.mimetype.startsWith('image/')) {
      return calculateCreditsForUnits(CreditCostType.IMAGE_UPLOAD, 1);
    }

    return 0;
  }

  async uploadAvatar(userId: string, file: Express.Multer.File) {
    const safeFileName = this.toStorageSafeFileName(file.originalname);
    const r2Key = `uploads/${userId}/avatar/${Date.now()}-${safeFileName}`;

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: r2Key,
        Body: file.buffer,
        ContentType: file.mimetype,
      }),
    );

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { avatarUrl: r2Key },
    });

    return {
      avatarUrl: this.toAvatarEndpointUrl(user.id, user.avatarUrl),
      user: {
        ...user,
        avatarUrl: this.toAvatarEndpointUrl(user.id, user.avatarUrl),
      },
    };
  }

  async deleteFile(fileId: string) {
    const file = await this.prisma.uploadedFile.findUnique({ where: { id: fileId } });
    if (!file) return;

    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: file.r2Key })).catch(() => {});
    await this.prisma.uploadedFile.delete({ where: { id: fileId } });
  }

  async getObjectBuffer(objectKey: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const response = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucketName, Key: objectKey }),
    );

    const chunks: Buffer[] = [];
    for await (const chunk of response.Body as Readable) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return {
      buffer: Buffer.concat(chunks),
      mimeType: response.ContentType || 'application/octet-stream',
    };
  }

  async findAllByUser(
    userId: string,
    options?: { page?: number; limit?: number; name?: string; paginate?: boolean; timeOrder?: 'asc' | 'desc' },
  ) {
    const paginate = options?.paginate ?? false;
    const page = options?.page ?? 1;
    const limit = options?.limit ?? 6;
    const skip = (page - 1) * limit;
    const timeOrder = options?.timeOrder === 'asc' ? 'asc' : 'desc';

    const where: any = { userId };

    if (options?.name) {
      where.originalName = { contains: options.name, mode: 'insensitive' };
    }

    const findArgs: any = {
      where,
      orderBy: { createdAt: timeOrder },
      include: {
        quizzes: {
          select: {
            id: true,
            title: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    };

    if (paginate) {
      findArgs.skip = skip;
      findArgs.take = limit;
    }

    const [files, total] = await Promise.all([
      this.prisma.uploadedFile.findMany(findArgs),
      paginate ? this.prisma.uploadedFile.count({ where }) : Promise.resolve(0),
    ]);

    if (!paginate) {
      return files;
    }

    return {
      data: files,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOne(id: string, userId: string) {
    const file = await this.prisma.uploadedFile.findUnique({ where: { id } });
    if (!file) {
      return null;
    }

    if (file.userId !== userId) {
      throw new ForbiddenException('You cannot access this file');
    }

    return file;
  }

  async getViewUrlForUser(fileId: string, userId: string) {
    const file = await this.prisma.uploadedFile.findUnique({ where: { id: fileId } });
    if (!file) {
      throw new NotFoundException('File not found');
    }

    if (file.userId !== userId) {
      throw new ForbiddenException('You cannot access this file');
    }

    const url = await getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.bucketName,
        Key: file.r2Key,
        ResponseContentType: file.mimeType || 'application/octet-stream',
        ResponseContentDisposition: this.buildInlineContentDisposition(file.originalName),
      }),
      { expiresIn: this.signedViewUrlTtlSeconds },
    );

    return {
      url,
      expiresIn: this.signedViewUrlTtlSeconds,
    };
  }

  async remove(fileId: string, userId: string) {
    const file = await this.prisma.uploadedFile.findUnique({ where: { id: fileId } });
    if (!file) {
      throw new NotFoundException('File not found');
    }

    if (file.userId !== userId) {
      throw new ForbiddenException('You cannot delete this file');
    }

    await this.s3.send(
      new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: file.r2Key,
      }),
    );

    await this.prisma.uploadedFile.delete({ where: { id: fileId } });

    return {
      id: fileId,
      deleted: true,
    };
  }

  async getFileBuffer(fileId: string): Promise<{ buffer: Buffer; mimeType: string; originalName: string }> {
    const file = await this.prisma.uploadedFile.findUnique({ where: { id: fileId } });
    if (!file) throw new NotFoundException('File not found');

    const response = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucketName, Key: file.r2Key }),
    );

    const chunks: Buffer[] = [];
    for await (const chunk of response.Body as Readable) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return { buffer: Buffer.concat(chunks), mimeType: file.mimeType, originalName: file.originalName };
  }

  async getFileBufferForUser(
    fileId: string,
    userId: string,
  ): Promise<{ buffer: Buffer; mimeType: string; originalName: string }> {
    const file = await this.prisma.uploadedFile.findUnique({ where: { id: fileId } });
    if (!file) {
      throw new NotFoundException('File not found');
    }

    if (file.userId !== userId) {
      throw new ForbiddenException('You cannot access this file');
    }

    const response = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucketName, Key: file.r2Key }),
    );

    const chunks: Buffer[] = [];
    for await (const chunk of response.Body as Readable) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return { buffer: Buffer.concat(chunks), mimeType: file.mimeType, originalName: file.originalName };
  }

  private buildInlineContentDisposition(fileName: string) {
    return `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`;
  }

  private toAvatarEndpointUrl(userId: string, value?: string | null) {
    if (!value) {
      return null;
    }

    return `${this.appBaseUrl}/users/${encodeURIComponent(userId)}/avatar`;
  }

  private toStorageSafeFileName(fileName: string) {
    const normalized = (fileName || 'file').normalize('NFKC').trim();
    const baseName = normalized.split(/[\\/]/).pop() || 'file';

    const lastDotIndex = baseName.lastIndexOf('.');
    const rawName = lastDotIndex > 0 ? baseName.slice(0, lastDotIndex) : baseName;
    const rawExt = lastDotIndex > 0 ? baseName.slice(lastDotIndex + 1) : '';

    const safeName = rawName
      .replace(/\s+/g, '-')
      .replace(/[^a-zA-Z0-9._-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '') || 'file';

    const safeExt = rawExt
      .replace(/[^a-zA-Z0-9]/g, '')
      .toLowerCase();

    return safeExt ? `${safeName}.${safeExt}` : safeName;
  }
}

