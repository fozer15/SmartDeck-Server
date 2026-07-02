import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { ConnectionOptions } from 'bullmq';
import { Worker } from 'bullmq';
import { EnvService } from '../env/env.service';
import { QuizzesService } from './quizzes.service';
import { QUIZ_GENERATION_QUEUE_NAME, QuizGenerationQueueData } from './quiz-generation.constants';

@Injectable()
export class QuizGenerationWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QuizGenerationWorkerService.name);
  private readonly connection: ConnectionOptions;
  private worker: Worker<QuizGenerationQueueData> | null = null;

  constructor(
    private readonly env: EnvService,
    private readonly quizzesService: QuizzesService,
  ) {
    const redisUrl = new URL(this.env.redisUrl);
    const db = redisUrl.pathname ? Number(redisUrl.pathname.replace('/', '')) : undefined;

    this.connection = {
      host: redisUrl.hostname,
      port: redisUrl.port ? Number(redisUrl.port) : 6379,
      username: redisUrl.username || undefined,
      password: redisUrl.password || undefined,
      db: Number.isFinite(db) ? db : undefined,
      maxRetriesPerRequest: null,
    };
  }

  /**
   * Auto-start the worker in development so a single `npm run start:dev`
   * runs both the HTTP API and the background job processor. In production
   * we skip this and rely on the dedicated `worker.ts` entry point (see
   * ecosystem.config.js) so job concurrency isn't multiplied across the
   * clustered API instances.
   */
  async onModuleInit() {
    if (process.env.NODE_ENV === 'production') {
      return;
    }
    await this.start();
  }

  async start() {
    if (this.worker) {
      return;
    }

    this.worker = new Worker<QuizGenerationQueueData>(
      QUIZ_GENERATION_QUEUE_NAME,
      async (job) => {
        await this.quizzesService.processGenerationJob(job.data.generationJobId);
      },
      {
        connection: this.connection,
        concurrency: this.env.quizGenerationWorkerConcurrency,
        // Gemini generations can run 60–120 s. The default 30 s lock would
        // cause BullMQ to re-deliver the job to a second worker while the
        // first is still generating → duplicate decks + rows stuck at
        // `processing`. Give ourselves plenty of headroom.
        lockDuration: 180_000,   // 3 min — must exceed longest expected job
        stalledInterval: 60_000, // check for stalled jobs less aggressively
        maxStalledCount: 0,      // never auto-re-deliver stalled jobs
      },
    );

    this.worker.on('completed', (job) => {
      this.logger.log(`Completed quiz generation job ${job.id}`);
    });

    this.worker.on('failed', (job, error) => {
      this.logger.error(`Failed quiz generation job ${job?.id}: ${error.message}`);
    });

    await this.worker.waitUntilReady();
    this.logger.log(`Quiz generation worker is ready with concurrency ${this.env.quizGenerationWorkerConcurrency}`);
  }

  async onModuleDestroy() {
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
  }
}