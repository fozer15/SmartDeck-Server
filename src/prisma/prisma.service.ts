import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(config: ConfigService) {
    super({
      datasources: {
        db: {
          url: PrismaService.buildDatabaseUrl(
            config.getOrThrow<string>('DATABASE_URL'),
            config.get<string>('DATABASE_CONNECTION_LIMIT'),
            config.get<string>('NODE_ENV') || 'development',
          ),
        },
      },
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  private static buildDatabaseUrl(databaseUrl: string, configuredLimit: string | undefined, nodeEnv: string) {
    const url = new URL(databaseUrl);

    if (!url.searchParams.has('connection_limit')) {
      const parsedLimit = Number(configuredLimit);
      const connectionLimit = Number.isInteger(parsedLimit) && parsedLimit > 0
        ? parsedLimit
        : nodeEnv === 'production'
          ? null
          : 3;

      if (connectionLimit) {
        url.searchParams.set('connection_limit', String(connectionLimit));
      }
    }

    return url.toString();
  }
}
