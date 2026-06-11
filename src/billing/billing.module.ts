import { Module } from '@nestjs/common';
import { BillingService } from './billing.service';
import { RevenueCatModule } from '../revenueCat/revenuecat.module';

@Module({
  imports: [RevenueCatModule],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}