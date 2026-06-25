import { ForbiddenException, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EnvService } from '../env/env.service';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { parseBuffer } from 'music-metadata';
import { Readable } from 'stream';
import { BillingService } from '../billing/billing.service';
import { CreditCostType, calculateCreditsForUnits } from '../config/plan-limits';
import { createHmac, timingSafeEqual } from 'crypto';
import { CreateSignedUploadDto, SignedUploadType } from './dto/create-signed-upload.dto';

type SignedUploadTokenPayload = {
  userId: string;
  key: string;
  originalName: string;
  mimeType: string;
  size: number;
  uploadType: SignedUploadType;
  creditCost: number;
  expiresAt: number;
};

type SignedUploadConstraints = {
  allowedMimeTypes: string[];
  maxFileSize: number;
};

@Injectable()
export class FilesService {
  private s3: S3Client;
  private bucketName: string;
  private readonly signedViewUrlTtlSeconds = 300;
  private readonly signedUploadUrlTtlSeconds = 900;
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

  async createSignedUpload(userId: string, input: CreateSignedUploadDto) {
    const normalizedMimeType = String(input.mimeType || '').trim().toLowerCase();
    const constraints = this.getSignedUploadConstraints(input.uploadType);
    const safeFileName = this.toStorageSafeFileName(input.fileName);

    if (!constraints.allowedMimeTypes.includes(normalizedMimeType)) {
      throw new BadRequestException(this.getInvalidMimeTypeMessage(input.uploadType));
    }

    if (!Number.isFinite(input.size) || input.size <= 0 || input.size > constraints.maxFileSize) {
      throw new BadRequestException(this.getInvalidFileSizeMessage(input.uploadType, constraints.maxFileSize));
    }

    const uploadCreditCost = this.calculateSignedUploadCreditCost(input, safeFileName);

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

    const key = input.uploadType === 'avatar'
      ? `uploads/${userId}/avatar/${Date.now()}-${safeFileName}`
      : `uploads/${userId}/files/${Date.now()}-${safeFileName}`;
    const uploadUrl = await getSignedUrl(
      this.s3,
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        ContentType: normalizedMimeType,
      }),
      { expiresIn: this.signedUploadUrlTtlSeconds },
    );

    const uploadToken = this.signUploadToken({
      userId,
      key,
      originalName: safeFileName,
      mimeType: normalizedMimeType,
      size: input.size,
      uploadType: input.uploadType,
      creditCost: uploadCreditCost,
      expiresAt: Date.now() + this.signedUploadUrlTtlSeconds * 1000,
    });

    return {
      status: 'ready',
      uploadUrl,
      uploadToken,
      expiresIn: this.signedUploadUrlTtlSeconds,
      method: 'PUT',
      headers: {
        'Content-Type': normalizedMimeType,
      },
    };
  }

  async completeSignedUpload(userId: string, uploadToken: string) {
    const payload = this.verifyUploadToken(uploadToken);

    if (payload.userId !== userId) {
      throw new ForbiddenException('You cannot complete another user\'s upload.');
    }

    if (payload.uploadType !== 'avatar') {
      const existingFile = await this.prisma.uploadedFile.findFirst({
        where: {
          userId,
          r2Key: payload.key,
        },
      });

      if (existingFile) {
        return existingFile;
      }
    }

    const objectHead = await this.s3.send(
      new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: payload.key,
      }),
    ).catch(() => {
      throw new BadRequestException('Uploaded file could not be found in storage. Please upload the file again.');
    });

    if ((objectHead.ContentLength || 0) !== payload.size) {
      throw new BadRequestException('Uploaded file size did not match the signed upload request.');
    }

    const storedMimeType = String(objectHead.ContentType || '').trim().toLowerCase();
    if (storedMimeType && storedMimeType !== payload.mimeType) {
      throw new BadRequestException('Uploaded file type did not match the signed upload request.');
    }

    const storedSize = Number(objectHead.ContentLength || payload.size);
    const resolvedMimeType = storedMimeType || payload.mimeType;
    const resolvedCreditCost = payload.uploadType === 'audio' && payload.creditCost <= 0
      ? await this.resolveAudioUploadCreditCost(payload.key, resolvedMimeType, payload.originalName)
      : payload.creditCost;

    if (resolvedCreditCost > 0) {
      const affordability = await this.billing.canAffordCredits(userId, resolvedCreditCost);
      if (!affordability.canAfford) {
        await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: payload.key })).catch(() => {});
        return {
          status: 'credits_needed',
          requiredCredits: resolvedCreditCost,
          remainingCredits: affordability.remainingCredits,
          monthlyCredits: affordability.monthlyCredits,
        };
      }
    }

    if (payload.uploadType === 'avatar') {
      const user = await this.prisma.user.update({
        where: { id: userId },
        data: { avatarUrl: payload.key },
      });

      return {
        avatarUrl: this.toAvatarEndpointUrl(user.id, user.avatarUrl),
        user: {
          ...user,
          avatarUrl: this.toAvatarEndpointUrl(user.id, user.avatarUrl),
        },
      };
    }

    const createdFile = await this.prisma.uploadedFile.create({
      data: {
        userId,
        originalName: payload.originalName,
        r2Key: payload.key,
        mimeType: resolvedMimeType,
        size: storedSize,
      },
    });

    if (resolvedCreditCost > 0) {
      try {
        await this.billing.consumeCredits(userId, resolvedCreditCost, 'File upload');
      } catch (error) {
        await this.deleteFile(createdFile.id).catch(() => {});
        throw error;
      }
    }

    return createdFile;
  }

  private calculateSignedUploadCreditCost(input: CreateSignedUploadDto, safeFileName: string) {
    if (input.uploadType === 'pdf') {
      if (!Number.isInteger(input.pageCount) || input.pageCount <= 0) {
        throw new BadRequestException(`Missing or invalid PDF page count for: ${safeFileName}.`);
      }

      return calculateCreditsForUnits(CreditCostType.PDF_PAGE, input.pageCount);
    }

    if (input.uploadType === 'audio') {
      if (input.audioDurationSeconds === undefined || input.audioDurationSeconds === null) {
        return 0;
      }

      if (!Number.isFinite(input.audioDurationSeconds) || Number(input.audioDurationSeconds) <= 0) {
        throw new BadRequestException(`Missing or invalid audio duration for: ${safeFileName}.`);
      }

      const durationInMinutes = Math.max(1, Math.ceil(Number(input.audioDurationSeconds) / 60));
      return calculateCreditsForUnits(CreditCostType.AUDIO_MINUTE, durationInMinutes);
    }

    if (input.uploadType === 'image') {
      return calculateCreditsForUnits(CreditCostType.IMAGE_UPLOAD, 1);
    }

    if (input.uploadType === 'avatar') {
      return 0;
    }

    return 0;
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

  private getSignedUploadConstraints(uploadType: SignedUploadType): SignedUploadConstraints {
    switch (uploadType) {
      case 'pdf':
        return {
          allowedMimeTypes: ['application/pdf'],
          maxFileSize: 20 * 1024 * 1024,
        };
      case 'audio':
        return {
          allowedMimeTypes: ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/ogg', 'audio/webm', 'audio/x-m4a', 'audio/m4a', 'audio/mp4', 'audio/aac', 'audio/flac'],
          maxFileSize: 50 * 1024 * 1024,
        };
      case 'image':
        return {
          allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
          maxFileSize: 20 * 1024 * 1024,
        };
      case 'avatar':
        return {
          allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
          maxFileSize: 5 * 1024 * 1024,
        };
      default:
        throw new BadRequestException('Unsupported upload type.');
    }
  }

  private getInvalidMimeTypeMessage(uploadType: SignedUploadType) {
    switch (uploadType) {
      case 'pdf':
        return 'Only PDF files are allowed.';
      case 'audio':
        return 'Only audio files are allowed (MP3, WAV, OGG, WebM, M4A, AAC, FLAC).';
      case 'image':
        return 'Only image files are allowed (PNG, JPEG, WEBP).';
      case 'avatar':
        return 'Only avatar images are allowed (PNG, JPEG, WEBP).';
      default:
        return 'Unsupported file type.';
    }
  }

  private getInvalidFileSizeMessage(uploadType: SignedUploadType, maxFileSize: number) {
    const sizeMb = Math.floor(maxFileSize / (1024 * 1024));

    switch (uploadType) {
      case 'pdf':
        return `PDF files must be smaller than ${sizeMb} MB.`;
      case 'audio':
        return `Audio files must be smaller than ${sizeMb} MB.`;
      case 'image':
        return `Image files must be smaller than ${sizeMb} MB.`;
      case 'avatar':
        return `Avatar images must be smaller than ${sizeMb} MB.`;
      default:
        return `Files must be smaller than ${sizeMb} MB.`;
    }
  }

  private signUploadToken(payload: SignedUploadTokenPayload) {
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', this.getUploadTokenSecret())
      .update(encodedPayload)
      .digest('base64url');

    return `${encodedPayload}.${signature}`;
  }

  private async resolveAudioUploadCreditCost(key: string, mimeType: string, originalName: string) {
    const { buffer } = await this.getObjectBuffer(key);

    try {
      const metadata = await parseBuffer(buffer, { mimeType }, { duration: true });
      const durationSeconds = Number(metadata.format.duration || 0);

      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        throw new Error('missing_duration');
      }

      const durationInMinutes = Math.max(1, Math.ceil(durationSeconds / 60));
      return calculateCreditsForUnits(CreditCostType.AUDIO_MINUTE, durationInMinutes);
    } catch {
      throw new BadRequestException(`Could not read audio duration for: ${originalName}.`);
    }
  }

  private verifyUploadToken(uploadToken: string): SignedUploadTokenPayload {
    const [encodedPayload, providedSignature] = String(uploadToken || '').split('.');

    if (!encodedPayload || !providedSignature) {
      throw new BadRequestException('Invalid upload token.');
    }

    const expectedSignature = createHmac('sha256', this.getUploadTokenSecret())
      .update(encodedPayload)
      .digest('base64url');

    const providedBuffer = Buffer.from(providedSignature);
    const expectedBuffer = Buffer.from(expectedSignature);

    if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) {
      throw new BadRequestException('Invalid upload token signature.');
    }

    let payload: SignedUploadTokenPayload;

    try {
      payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as SignedUploadTokenPayload;
    } catch {
      throw new BadRequestException('Invalid upload token payload.');
    }

    if (!payload?.userId || !payload?.key || !payload?.mimeType || !payload?.originalName) {
      throw new BadRequestException('Upload token payload is incomplete.');
    }

    if (!Number.isFinite(payload.expiresAt) || payload.expiresAt <= Date.now()) {
      throw new BadRequestException('Upload token has expired.');
    }

    return payload;
  }

  private getUploadTokenSecret() {
    return `${this.env.r2AccessKeyId}:${this.env.r2SecretAccessKey}`;
  }

  private toAvatarEndpointUrl(userId: string, value?: string | null) {
    if (!value) {
      return null;
    }

    return `${this.appBaseUrl}/users/${encodeURIComponent(userId)}/avatar?v=${encodeURIComponent(value)}`;
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

