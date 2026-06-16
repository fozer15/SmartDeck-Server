import { Module, forwardRef } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { AuthModule } from '../auth/auth.module';
import { FilesModule } from '../files/files.module';
import { BillingModule } from '../billing/billing.module';

@Module({
  imports: [forwardRef(() => AuthModule), forwardRef(() => FilesModule), forwardRef(() => BillingModule)],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
