import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { FilesModule } from '../files/files.module';
import { QuizzesModule } from '../quizzes/quizzes.module';
import { TutorChatController } from './tutor-chat.controller';
import { TutorChatService } from './tutor-chat.service';

@Module({
  // EnvModule (which exports GeminiService) and PrismaModule are global —
  // no need to import them explicitly. QuizzesModule must export
  // QuizzesService so we can reuse `getDeckAnalytics`.
  imports: [AuthModule, BillingModule, FilesModule, QuizzesModule],
  controllers: [TutorChatController],
  providers: [TutorChatService],
})
export class TutorChatModule {}
