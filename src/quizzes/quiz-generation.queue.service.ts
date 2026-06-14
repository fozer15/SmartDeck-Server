import { Injectable, OnModuleDestroy } from '@nestjs/common';
import type { ConnectionOptions } from 'bullmq';
import { Queue } from 'bullmq';
import { EnvService } from '../env/env.service';
import {
  QUIZ_GENERATION_JOB_NAME,
  QUIZ_GENERATION_QUEUE_NAME,
  QuizGenerationQueueData,
} from './quiz-generation.constants';

@Injectable()
export class QuizGenerationQueueService implements OnModuleDestroy {
  private readonly connection: ConnectionOptions;
  private readonly queue;

  constructor(private readonly env: EnvService) {
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

    this.queue = new Queue<QuizGenerationQueueData>(QUIZ_GENERATION_QUEUE_NAME, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: 1000,
        removeOnFail: 1000,
      },
    });
  }

  enqueueGenerationJob(generationJobId: string) {
    return this.queue.add(
      QUIZ_GENERATION_JOB_NAME,
      { generationJobId },
      { jobId: generationJobId },
    );
  }

  async onModuleDestroy() {
    await this.queue.close();
  }
}