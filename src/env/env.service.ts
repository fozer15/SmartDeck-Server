import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class EnvService {
  readonly firebaseProjectId: string;
  readonly firebaseClientEmail: string;
  readonly firebasePrivateKey: string;

  readonly geminiApiKey: string;
  readonly geminiModel: string;

  readonly r2AccountId: string;
  readonly r2AccessKeyId: string;
  readonly r2SecretAccessKey: string;
  readonly r2BucketName: string;
  readonly r2PublicUrl: string;
  readonly appBaseUrl: string;

  constructor(config: ConfigService) {
    this.firebaseProjectId = config.getOrThrow('FIREBASE_PROJECT_ID');
    this.firebaseClientEmail = config.getOrThrow('FIREBASE_CLIENT_EMAIL');
    this.firebasePrivateKey = config.getOrThrow<string>('FIREBASE_PRIVATE_KEY').replace(/\\n/g, '\n');
    this.geminiApiKey = config.getOrThrow('GEMINI_API_KEY');
    this.geminiModel = config.get<string>('GEMINI_MODEL');
    this.r2AccountId = config.getOrThrow('R2_ACCOUNT_ID');
    this.r2AccessKeyId = config.getOrThrow('R2_ACCESS_KEY_ID');
    this.r2SecretAccessKey = config.getOrThrow('R2_SECRET_ACCESS_KEY');
    this.r2BucketName = config.getOrThrow('R2_BUCKET_NAME');
    this.r2PublicUrl = config.getOrThrow<string>('R2_PUBLIC_URL').replace(/\/$/, '');
    this.appBaseUrl = (config.get<string>('APP_BASE_URL') || 'http://localhost:3000').replace(/\/$/, '');
  }
}
