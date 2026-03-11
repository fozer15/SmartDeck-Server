import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import * as fs from 'fs';
import { Readable } from 'stream';

@Injectable()
export class FilesService {
  private s3: S3Client;
  private bucketName: string;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {
    this.s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${config.get('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.get('R2_ACCESS_KEY_ID'),
        secretAccessKey: config.get('R2_SECRET_ACCESS_KEY'),
      },
    });
    this.bucketName = config.get('R2_BUCKET_NAME');
  }

  async upload(userId: string, file: Express.Multer.File) {
    const r2Key = `uploads/${userId}/${Date.now()}-${file.originalname}`;

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: r2Key,
        Body: fs.readFileSync(file.path),
        ContentType: file.mimetype,
      }),
    );

    fs.unlinkSync(file.path);

    return this.prisma.uploadedFile.create({
      data: {
        userId,
        originalName: file.originalname,
        r2Key,
        mimeType: file.mimetype,
        size: file.size,
      },
    });
  }

  async findAllByUser(userId: string) {
    return this.prisma.uploadedFile.findMany({ where: { userId } });
  }

  async findOne(id: string) {
    return this.prisma.uploadedFile.findUnique({ where: { id } });
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
}

