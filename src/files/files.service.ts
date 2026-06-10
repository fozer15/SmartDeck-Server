import { ForbiddenException, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EnvService } from '../env/env.service';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'stream';
import { PDFDocument } from 'pdf-lib';
import { RevenueCatService } from "../revenueCat/revenuecat.service";
import { APP_LIMITS, PlanType } from "../config/plan-limits";
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
    private revenueCat: RevenueCatService
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
    const hasActiveEntitlement = await this.revenueCat.hasActiveEntitlement(userId, "SmartDeck Pro");
    
    // --- PRO GUARDS ---
    if (!hasActiveEntitlement) {
      // Fetch usage once for all file types
      const usage = await this.prisma.userUsageLimit.findUnique({
        where: { userId }
      });

      if (!usage) {
        throw new NotFoundException('User usage records not found.');
      }

      // 1. PDF Limits
      if (file.mimetype === 'application/pdf') {
        if (usage.pdfPagesUsed >= APP_LIMITS.MONTHLY_QUOTAS["FREE"].pdfPages) {
          return { status: "pro_needed" };
        }

        let pageCount = 0;
        try {
          const pdfDoc = await PDFDocument.load(file.buffer);
          pageCount = pdfDoc.getPageCount();
        } catch (error) {
          // Catching pdf-lib errors specifically so we can reject the upload entirely
          throw new BadRequestException(`Could not parse PDF file: ${safeFileName}. The file may be corrupt.`);
        }

        if (usage.pdfPagesUsed + pageCount > APP_LIMITS.MONTHLY_QUOTAS["FREE"].pdfPages) {
          return { status: "pro_needed" };
        }

        await this.prisma.userUsageLimit.update({ 
          where: { userId }, 
          data: { pdfPagesUsed: { increment: pageCount } } 
        });
      }

      // 2. Audio Limits
      else if (file.mimetype.startsWith('audio/')) {
        if (usage.audioMinutesUsed >= APP_LIMITS.MONTHLY_QUOTAS["FREE"].audioMinutes) {
          return { status: "pro_needed" };
        }

        let durationInMinutes = 0;
        try {
          const metadata = await parseBuffer(file.buffer, { mimeType: file.mimetype });
          if (!metadata.format.duration) {
             throw new Error('No duration found');
          }
          durationInMinutes = Number((metadata.format.duration / 60).toFixed(2));
        } catch (error) {
          throw new BadRequestException(`Could not read audio duration for: ${safeFileName}. Unrecognized or corrupt format.`);
        }

        if (usage.audioMinutesUsed + durationInMinutes > APP_LIMITS.MONTHLY_QUOTAS["FREE"].audioMinutes) {
          return { status: "pro_needed" };
        }
        
        await this.prisma.userUsageLimit.update({ 
          where: { userId }, 
          data: { audioMinutesUsed: { increment: durationInMinutes } } 
        });
      }

      // 3. Image Limits
      else if (file.mimetype.startsWith("image/")) {
        if (usage.imageUsed + 1 > APP_LIMITS.MONTHLY_QUOTAS["FREE"].image) {
          return { status: "pro_needed" };
        }

        await this.prisma.userUsageLimit.update({ 
          where: { userId }, 
          data: { imageUsed: { increment: 1 } } 
        });
      }
    }
    // --- END PRO GUARDS ---

    // Proceed to upload only if limits checks passed and parsing didn't throw errors
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

    return createdFile;
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

