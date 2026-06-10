import { Module, forwardRef } from '@nestjs/common';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { AuthModule } from '../auth/auth.module';
import {RevenueCatModule} from "../revenueCat/revenuecat.module"

@Module({
  controllers: [FilesController],
  providers: [FilesService],
  exports: [FilesService],
  imports: [forwardRef(() => AuthModule),RevenueCatModule],
})
export class FilesModule {}
