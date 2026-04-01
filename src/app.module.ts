import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EnvModule } from './env/env.module';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { FilesModule } from './files/files.module';
import { QuizzesModule } from './quizzes/quizzes.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    EnvModule,
    PrismaModule,
    AuthModule,
    UsersModule,
    FilesModule,
    QuizzesModule,
  ],
})
export class AppModule {}
