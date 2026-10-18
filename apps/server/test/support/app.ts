import type { Persistence, Tracer } from '@cloud-trigger/core';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { pino } from 'pino';

import { AppModule } from '../../src/app.module.js';
import { resolveToken } from '../../src/common/tokens.js';
import type { AppConfig } from '../../src/config/config.js';
import { PERSISTENCE } from '../../src/infra/persistence/persistence.module.js';

export interface TestApp {
  readonly app: INestApplication;
  readonly persistence: Persistence;
}

export async function createTestApp(
  config: AppConfig,
  options: { readonly tracer?: Tracer | undefined } = {},
): Promise<TestApp> {
  const app = await NestFactory.create(
    AppModule.forRoot({ config, pino: pino({ level: 'silent' }), tracer: options.tracer }),
    { bodyParser: false, logger: false },
  );

  return { app, persistence: resolveToken(app, PERSISTENCE) };
}
