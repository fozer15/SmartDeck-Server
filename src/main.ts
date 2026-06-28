import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { EnvService } from './env/env.service';

const DEFAULT_CLIENT_APP_URL = 'https://app.usesmartdeck.com';
const DEV_CLIENT_ORIGIN_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

function normalizeOrigin(origin: string) {
  return origin.replace(/\/$/, '');
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
  });

  app.enableShutdownHooks();

  const env = app.get(EnvService);
  const allowedOrigins = new Set([
    DEFAULT_CLIENT_APP_URL,
    normalizeOrigin(env.clientAppUrl),
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ]);

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }

      const normalizedOrigin = normalizeOrigin(origin);
      if (allowedOrigins.has(normalizedOrigin) || DEV_CLIENT_ORIGIN_PATTERN.test(normalizedOrigin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origin ${origin} not allowed by CORS`), false);
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 204,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  await app.listen(process.env.PORT ?? 3000);
}

bootstrap();
