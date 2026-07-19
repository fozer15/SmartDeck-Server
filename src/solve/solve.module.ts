import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { FilesModule } from '../files/files.module';
import { SolveController } from './solve.controller';
import { SolveService } from './solve.service';

@Module({
  // EnvModule (GeminiService) and PrismaModule are @Global — no explicit import needed.
  imports: [AuthModule, BillingModule, FilesModule],
  controllers: [SolveController],
  providers: [SolveService],
})
export class SolveModule {}
