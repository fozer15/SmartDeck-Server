import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { ConnectionOptions } from 'bullmq';
import { Worker } from 'bullmq';
import { EnvService } from '../env/env.service';
import { SolveService } from './solve.service';
import { SOLVE_QUEUE_NAME, SolveQueueData } from './solve-job.constants';

@Injectable()
export class SolveJobWorkerService implements OnModuleDestroy {
  private readonly logger = new Logger(SolveJobWorkerService.name);
  private readonly connection: ConnectionOptions;
  private worker: Worker<SolveQueueData> | null = null;

  constructor(
    private readonly env: EnvService,
    private readonly solveService: SolveService,
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

    this.worker = new Worker<SolveQueueData>(
      SOLVE_QUEUE_NAME,
      async (job) => {
        await this.solveService.processSolveJob(job.data.solveJobId);
      },
      {
        connection: this.connection,
        concurrency: this.env.solveWorkerConcurrency,
      },
    );

    this.worker.on('completed', (job) => {
      this.logger.log(`Completed solve job ${job.id}`);
    });

    this.worker.on('failed', (job, error) => {
      this.logger.error(`Failed solve job ${job?.id}: ${error.message}`);
    });

    await this.worker.waitUntilReady();
    this.logger.log(`Solve worker is ready with concurrency ${this.env.solveWorkerConcurrency}`);
  }

  async onModuleDestroy() {
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
  }
}
