import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EnvService } from '../env/env.service';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'stream';

@Injectable()
export class FilesService {
  private s3: S3Client;
  private bucketName: string;
  private r2PublicUrl: string;
  private readonly signedViewUrlTtlSeconds = 300;

  constructor(
    private prisma: PrismaService,
    private env: EnvService,
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
    this.r2PublicUrl = env.r2PublicUrl;
  }

  async upload(userId: string, file: Express.Multer.File) {
    const safeFileName = this.toStorageSafeFileName(file.originalname);
    const r2Key = `uploads/${userId}/files/${Date.now()}-${safeFileName}`;

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
        originalName: file.originalname,
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
      avatarUrl: this.toPublicUrl(user.avatarUrl),
      user: {
        ...user,
        avatarUrl: this.toPublicUrl(user.avatarUrl),
      },
    };
  }

  async findAllByUser(
    userId: string,
    options?: { page?: number; limit?: number; name?: string; paginate?: boolean },
  ) {
    const paginate = options?.paginate ?? false;
    const page = options?.page ?? 1;
    const limit = options?.limit ?? 6;
    const skip = (page - 1) * limit;

    const where: any = { userId };

    if (options?.name) {
      where.originalName = { contains: options.name, mode: 'insensitive' };
    }

    const findArgs: any = {
      where,
      orderBy: { createdAt: 'desc' },
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

  private toPublicUrl(value?: string | null) {
    if (!value) {
      return null;
    }

    if (/^https?:\/\//i.test(value)) {
      return value;
    }

    const encodedKey = value
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');

    return this.r2PublicUrl ? `${this.r2PublicUrl}/${encodedKey}` : encodedKey;
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

