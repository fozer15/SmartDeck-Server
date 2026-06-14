import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { ConnectionOptions } from 'bullmq';
import { Worker } from 'bullmq';
import { EnvService } from '../env/env.service';
import { QuizzesService } from './quizzes.service';
import { QUIZ_GENERATION_QUEUE_NAME, QuizGenerationQueueData } from './quiz-generation.constants';

@Injectable()
export class QuizGenerationWorkerService implements OnModuleDestroy {
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