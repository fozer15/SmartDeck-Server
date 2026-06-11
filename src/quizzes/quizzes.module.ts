import { Module } from '@nestjs/common';
import { QuizzesController } from './quizzes.controller';
import { QuizzesService } from './quizzes.service';
import { FilesModule } from '../files/files.module';
import { AuthModule } from '../auth/auth.module';
import { RevenueCatModule } from 'src/revenueCat/revenuecat.module';
import { BillingModule } from '../billing/billing.module';

@Module({
  imports: [FilesModule, AuthModule, RevenueCatModule, BillingModule],
  controllers: [QuizzesController],
  providers: [QuizzesService],
})
export class QuizzesModule {}
