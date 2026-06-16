import { Module, forwardRef } from '@nestjs/common';
import { BillingService } from './billing.service';
import { RevenueCatModule } from '../revenueCat/revenuecat.module';
import { AuthModule } from '../auth/auth.module';
import { BillingController } from './billing.controller';

@Module({
  imports: [RevenueCatModule, forwardRef(() => AuthModule)],
  controllers: [BillingController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}