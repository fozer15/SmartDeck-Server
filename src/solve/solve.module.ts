import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { FilesModule } from '../files/files.module';
import { SolveJobQueueService } from './solve-job.queue.service';
import { SolveJobWorkerService } from './solve-job.worker.service';
import { SolveController } from './solve.controller';
import { SolveService } from './solve.service';

@Module({
  // EnvModule (GeminiService) and PrismaModule are @Global — no explicit import needed.
  imports: [AuthModule, BillingModule, FilesModule],
  controllers: [SolveController],
  providers: [SolveService, SolveJobQueueService, SolveJobWorkerService],
  exports: [SolveJobWorkerService],
})
export class SolveModule {}
