import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class EnvService {
  readonly nodeEnv: string;
  readonly isProduction: boolean;
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
  readonly clientAppUrl: string;
  readonly revenueCatApiKey: string;
  readonly revenueCatWebhookAuth: string;
  readonly redisUrl: string;
  readonly quizGenerationWorkerConcurrency: number;
  readonly solveWorkerConcurrency: number;
  readonly stripeSecretKey: string;
  readonly stripeWebhookSecret: string;
  readonly stripeProMonthlyPriceId: string;
  readonly stripeProYearlyPriceId: string;
  readonly stripeProMonthlyProductId: string;
  readonly stripeProYearlyProductId: string;
  readonly stripeRevenueCatApiKey: string;

  constructor(config: ConfigService) {
    this.nodeEnv = config.get<string>('NODE_ENV') || 'development';
    this.isProduction = this.nodeEnv === 'production';
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
    this.clientAppUrl = (config.get<string>('CLIENT_APP_URL') || 'http://localhost:5173').replace(/\/$/, '');
    this.revenueCatApiKey = config.getOrThrow('RC_API_KEY');
    this.revenueCatWebhookAuth = config.get<string>('RC_WEBHOOK_AUTH') || '';
    this.stripeRevenueCatApiKey = config.getOrThrow('STRIPE_RC_API_KEY');
    this.redisUrl = config.get<string>('REDIS_URL') || 'redis://127.0.0.1:6379';
    this.stripeSecretKey = this.getStripeConfigValue(config, 'STRIPE_SECRET_KEY', 'STRIPE_TEST_SECRET_KEY');
    this.stripeWebhookSecret = this.getStripeConfigValue(config, 'STRIPE_WEBHOOK_SECRET', 'STRIPE_TEST_WEBHOOK_SECRET');
    this.stripeProMonthlyPriceId = this.getStripeConfigValue(
      config,
      'STRIPE_PRO_MONTHLY_PRICE_ID',
      'STRIPE_TEST_PRO_MONTHLY_PRICE_ID',
    );
    this.stripeProYearlyPriceId = this.getStripeConfigValue(
      config,
      'STRIPE_PRO_YEARLY_PRICE_ID',
      'STRIPE_TEST_PRO_YEARLY_PRICE_ID',
    );
    this.stripeProMonthlyProductId = this.getStripeConfigValue(
      config,
      'STRIPE_PRO_MONTHLY_PRODUCT_ID',
      'STRIPE_TEST_PRO_MONTHLY_PRODUCT_ID',
    );
    this.stripeProYearlyProductId = this.getStripeConfigValue(
      config,
      'STRIPE_PRO_YEARLY_PRODUCT_ID',
      'STRIPE_TEST_PRO_YEARLY_PRODUCT_ID',
    );

    const configuredConcurrency = Number(config.get<string>('QUIZ_GENERATION_WORKER_CONCURRENCY') || 2);
    this.quizGenerationWorkerConcurrency = Number.isFinite(configuredConcurrency) && configuredConcurrency > 0
      ? Math.floor(configuredConcurrency)
      : 2;

    const configuredSolveConcurrency = Number(config.get<string>('SOLVE_WORKER_CONCURRENCY') || 5);
    this.solveWorkerConcurrency = Number.isFinite(configuredSolveConcurrency) && configuredSolveConcurrency > 0
      ? Math.floor(configuredSolveConcurrency)
      : 5;
  }

  private getStripeConfigValue(
    config: ConfigService,
    productionKey: string,
    testKey: string,
  ) {
    if (this.isProduction) {
      return config.get<string>(productionKey) || '';
    }

    return config.get<string>(testKey) || config.get<string>(productionKey) || '';
  }
}
