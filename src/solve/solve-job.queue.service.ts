import { Injectable, OnModuleDestroy } from '@nestjs/common';
import type { ConnectionOptions } from 'bullmq';
import { Queue } from 'bullmq';
import { EnvService } from '../env/env.service';
import { SOLVE_JOB_NAME, SOLVE_QUEUE_NAME, SolveQueueData } from './solve-job.constants';

@Injectable()
export class SolveJobQueueService implements OnModuleDestroy {
  private readonly connection: ConnectionOptions;
  private readonly queue: Queue<SolveQueueData>;

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

    this.queue = new Queue<SolveQueueData>(SOLVE_QUEUE_NAME, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: 2,
        removeOnComplete: 1000,
        removeOnFail: 1000,
      },
    });
  }

  enqueueSolveJob(solveJobId: string) {
    return this.queue.add(
      SOLVE_JOB_NAME,
      { solveJobId },
      { jobId: solveJobId },
    );
  }

  async onModuleDestroy() {
    await this.queue.close();
  }
}
