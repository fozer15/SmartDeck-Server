import { Module } from '@nestjs/common';
import { RevenueCatService } from './revenuecat.service';
// Import the module that provides your EnvService
import { EnvModule } from '../env/env.module'; 

@Module({
  imports: [EnvModule], // Inject your custom environment module here
  providers: [RevenueCatService],
  exports: [RevenueCatService],
})
export class RevenueCatModule {}