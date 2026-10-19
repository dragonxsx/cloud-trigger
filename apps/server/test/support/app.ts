import {
  AuthMethods,
  type Persistence,
  type Scope,
  type Tracer,
  newApiKeyId,
} from '@cloud-trigger/core';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { pino } from 'pino';

import { AppModule } from '../../src/app.module.js';
import { hashApiKey } from '../../src/auth/api-keys.js';
import { resolveToken } from '../../src/common/tokens.js';
import type { AppConfig } from '../../src/config/config.js';
import { PERSISTENCE } from '../../src/infra/persistence/persistence.module.js';

export interface TestApp {
  readonly app: INestApplication;
  readonly persistence: Persistence;
}

export interface SeedAuth {
  readonly apiKeys?: readonly { name: string; key: string; scopes: Scope[] }[];
  readonly anonymousScopes?: Scope[];
}

const OPEN_ACCESS: SeedAuth = { anonymousScopes: ['admin'] };

export async function seedAuth(persistence: Persistence, seed: SeedAuth): Promise<void> {
  const now = new Date();
  (
    await persistence.authSettings.create({
      ...AuthMethods.parse({ anonymous: { scopes: seed.anonymousScopes ?? [] } }),
      version: 1,
      sessionSecret: 'test-session-secret-test-session-secret',
      completedAt: now,
      updatedAt: now,
    })
  )._unsafeUnwrap();
  for (const key of seed.apiKeys ?? []) {
    (
      await persistence.apiKeys.insert({
        id: newApiKeyId(),
        name: key.name,
        hash: hashApiKey(key.key),
        prefix: key.key.slice(0, 8),
        scopes: key.scopes,
        createdAt: now,
      })
    )._unsafeUnwrap();
  }
}

export async function createTestApp(
  config: AppConfig,
  options: {
    readonly tracer?: Tracer | undefined;
    readonly auth?: SeedAuth | false;
  } = {},
): Promise<TestApp> {
  const app = await NestFactory.create(
    AppModule.forRoot({ config, pino: pino({ level: 'silent' }), tracer: options.tracer }),
    { bodyParser: false, logger: false },
  );
  const persistence = resolveToken(app, PERSISTENCE);
  if (options.auth !== false && (await persistence.authSettings.get()) === undefined) {
    await seedAuth(persistence, options.auth ?? OPEN_ACCESS);
  }

  return { app, persistence };
}
