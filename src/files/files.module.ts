import { Module, forwardRef } from '@nestjs/common';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { AuthModule } from '../auth/auth.module';
import {RevenueCatModule} from "../revenueCat/revenuecat.module"
import { BillingModule } from '../billing/billing.module';

@Module({
  controllers: [FilesController],
  providers: [FilesService],
  exports: [FilesService],
  imports: [forwardRef(() => AuthModule), RevenueCatModule, forwardRef(() => BillingModule)],
})
export class FilesModule {}
