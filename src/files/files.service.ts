import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EnvService } from '../env/env.service';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';

@Injectable()
export class FilesService {
  private s3: S3Client;
  private bucketName: string;
  private r2PublicUrl: string;

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

    return this.withPublicUrl(createdFile);
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

  async findAllByUser(userId: string) {
    const files = await this.prisma.uploadedFile.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    return files.map((file) => this.withPublicUrl(file));
  }

  async findOne(id: string, userId: string) {
    const file = await this.prisma.uploadedFile.findUnique({ where: { id } });
    if (!file) {
      return null;
    }

    if (file.userId !== userId) {
      throw new ForbiddenException('You cannot access this file');
    }

    return this.withPublicUrl(file);
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

  private withPublicUrl(file: {
    id: string;
    userId: string;
    originalName: string;
    r2Key: string;
    mimeType: string;
    size: number;
    createdAt: Date;
  }) {
    return {
      ...file,
      publicUrl: this.toPublicUrl(file.r2Key),
    };
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

