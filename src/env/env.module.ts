import { Global, Module } from '@nestjs/common';
import { EnvService } from './env.service';
import { GeminiService } from './gemini.service';

@Global()
@Module({
  providers: [EnvService, GeminiService],
  exports: [EnvService, GeminiService],
})
export class EnvModule {}
