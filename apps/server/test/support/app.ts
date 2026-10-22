import { Server } from 'node:http';

import {
  AuthMethods,
  type Persistence,
  type Scope,
  type Tracer,
  newApiKeyId,
} from '@cloud-trigger/core';
import type { TestRequestHandler } from '@cloud-trigger/testing';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { pino } from 'pino';

import { AppModule } from '../../src/app.module.js';
import { hashApiKey } from '../../src/auth/api-keys.js';
import { resolveToken } from '../../src/common/tokens.js';
import { type AppConfig, loadConfig } from '../../src/config/config.js';
import { PERSISTENCE } from '../../src/infra/persistence/persistence.module.js';
import { type Client, createClient } from './client.js';
import type { TestEnv } from './databases.js';

export interface TestApp {
  readonly app: INestApplication;
  readonly persistence: Persistence;
}

export interface SeedAuth {
  readonly apiKeys?: readonly { name: string; key: string; scopes: Scope[] }[];
  readonly anonymousScopes?: Scope[];
}

export interface TestAppOptions {
  readonly tracer?: Tracer | undefined;
  readonly auth?: SeedAuth | false;
}

export const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const OPEN_ACCESS: SeedAuth = { anonymousScopes: ['admin'] };

export const API_KEYS: SeedAuth = {
  apiKeys: [
    { name: 'admin', key: 'a-key', scopes: ['admin'] },
    { name: 'writer', key: 'w-key', scopes: ['write'] },
    { name: 'reader', key: 'r-key', scopes: ['read'] },
  ],
};

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
  options: TestAppOptions = {},
): Promise<TestApp> {
  const app = await NestFactory.create(
    AppModule.forRoot({ config, pino: pino({ level: 'silent' }), tracer: options.tracer }),
    { bodyParser: false, logger: false, abortOnError: false },
  );
  const persistence = resolveToken(app, PERSISTENCE);
  if (options.auth !== false && (await persistence.authSettings.get()) === undefined) {
    await seedAuth(persistence, options.auth ?? OPEN_ACCESS);
  }

  return { app, persistence };
}

export const respondOk: TestRequestHandler = (_req, res) => {
  res.end('{"ok":true}');
};

interface Listenable {
  listen(port: number, host: string, cb: () => void): unknown;
  address(): ReturnType<Server['address']>;
}

export const listen = async (server: Listenable): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP address');
  }

  return `http://127.0.0.1:${address.port}`;
};

export const listenNest = async (app: INestApplication): Promise<string> => {
  const http: unknown = app.getHttpServer();
  if (!(http instanceof Server)) {
    throw new Error('Expected a node:http server');
  }

  return listen(http);
};

export const testConfig = (env: TestEnv): AppConfig =>
  loadConfig({
    DATA_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    WORKER_POLL_MS: '100',
    SCHEDULER_INTERVAL_MS: '200',
    NOTIFY_POLL_MS: '100',
    ...env,
  });

export interface TestServer extends TestApp {
  readonly baseUrl: string;
  readonly client: (apiKey?: string) => Client;
  readonly close: () => Promise<void>;
}

export async function startTestServer(
  env: TestEnv,
  options: TestAppOptions = {},
): Promise<TestServer> {
  const { app, persistence } = await createTestApp(testConfig(env), options);
  app.enableShutdownHooks();
  await app.init();
  const baseUrl = await listenNest(app);

  return {
    app,
    persistence,
    baseUrl,
    client: (apiKey) => createClient(baseUrl, apiKey === undefined ? {} : { 'x-api-key': apiKey }),
    close: () => app.close(),
  };
}
