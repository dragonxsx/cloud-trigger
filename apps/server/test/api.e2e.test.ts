import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { Server, createServer } from 'node:http';

import { type Contract, contract } from '@cloud-trigger/api-contract';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createORPCClient, isDefinedError, safe } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import type { JsonifiedClient } from '@orpc/openapi-client';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type AppContext, createAppContext } from '../src/app-context.js';
import { AppModule } from '../src/app.module.js';
import { loadConfig } from '../src/config.js';

type Client = JsonifiedClient<ContractRouterClient<Contract>>;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
let container: StartedMongoDBContainer;
let app: INestApplication;
let ctx: AppContext;
let target: Server;
let targetUrl = '';
let baseUrl = '';
let received = 0;

const client = (apiKey?: string): Client =>
  createORPCClient(
    new OpenAPILink(contract, { url: baseUrl, headers: apiKey ? { 'x-api-key': apiKey } : {} }),
  );

interface Listenable {
  listen(port: number, host: string, cb: () => void): unknown;
  address(): ReturnType<Server['address']>;
}

const listen = async (server: Listenable): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('tcp');
  }

  return `http://127.0.0.1:${address.port}`;
};

beforeAll(async () => {
  container = await new MongoDBContainer('mongo:8').start();
  target = createServer((_req, res) => {
    received++;
    res.end('{"ok":true}');
  });
  targetUrl = await listen(target);

  const config = loadConfig({
    MONGO_URI: `${container.getConnectionString()}?directConnection=true`,
    MONGO_DB: 'e2e',
    WORKER_POLL_MS: '100',
    SCHEDULER_INTERVAL_MS: '200',
    API_KEYS: `writer:${sha256('w-key')}:write,reader:${sha256('r-key')}:read`,
  });
  ctx = await createAppContext(config, pino({ level: 'silent' }));
  app = await NestFactory.create(AppModule.forRoot(ctx), { bodyParser: false, logger: false });
  app.enableShutdownHooks();
  await app.init();
  const http: unknown = app.getHttpServer();
  if (!(http instanceof Server)) {
    throw new Error('Expected a node:http server');
  }
  baseUrl = await listen(http);
}, 120_000);

afterAll(async () => {
  await app.close();
  await container.stop();
  await new Promise<void>((resolve) => target.close(() => resolve()));
});

const waitFor = async <T>(fn: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error('timeout');
    }
    await new Promise((r) => setTimeout(r, 100));
  }
};

describe('API e2e (typed oRPC client)', () => {
  it('rejects anonymous and under-scoped callers with typed errors', async () => {
    const anon = await safe(client().jobs.list({}));
    expect(anon.isDefined && anon.error.code).toBe('UNAUTHORIZED');
    const reader = await safe(
      client('r-key').jobs.create({
        name: 'x',
        trigger: { type: 'once', config: {} },
        target: { type: 'http', config: {} },
      }),
    );
    expect(isDefinedError(reader.error) && reader.error.code).toBe('FORBIDDEN');
    expect((await client('r-key').auth.me({})).scopes).toEqual(['read']);
  });

  it('creates a job, runs it on demand, and reports results', async () => {
    const api = client('w-key');
    const invalid = await safe(
      api.jobs.create({
        name: 'bad',
        trigger: { type: 'cron', config: { expression: 'nope' } },
        target: { type: 'http', config: { url: targetUrl } },
      }),
    );
    expect(
      invalid.isDefined &&
        invalid.error.code === 'INVALID_CONFIG' &&
        invalid.error.data.issues[0]?.path,
    ).toBe('trigger.config.expression');

    const job = await api.jobs.create({
      name: 'e2e',
      trigger: { type: 'cron', config: { expression: '0 0 1 1 *' } },
      target: {
        type: 'http',
        config: { method: 'POST', url: `${targetUrl}/hook`, signing: { secret: 'shh' } },
      },
    });
    expect(job.createdAt).toBeTypeOf('string');
    expect(job.target.config).toMatchObject({ signing: { secret: '***' } });

    const pending = await api.jobs.run({ id: job.id });
    expect(pending.status).toBe('pending');
    const finished = await waitFor(async () => {
      const run = await api.runs.get({ id: pending.id });

      return run.status === 'succeeded' ? run : undefined;
    });
    expect(finished.status).toBe('succeeded');
    expect(received).toBe(1);

    const page = await api.runs.list({ jobId: job.id, status: ['succeeded'] });
    expect(page.items).toHaveLength(1);
    const summary = await waitFor(async () => {
      const current = await api.analytics.summary({
        from: new Date(Date.now() - 60_000).toISOString(),
        to: new Date(Date.now() + 60_000).toISOString(),
        jobId: job.id,
      });

      return current.total > 0 ? current : undefined;
    });
    expect(summary.byStatus).toEqual({ succeeded: 1 });
  });

  it('serves providers, OpenAPI, health and metrics', async () => {
    const providers = await client('r-key').providers.list({ kind: 'target' });
    expect(providers.map((p) => p.type)).toContain('http');
    const spec = await fetch(`${baseUrl}/api/openapi.json`);
    expect(spec.status).toBe(200);
    expect((await fetch(`${baseUrl}/health/ready`)).status).toBe(200);
    expect(await (await fetch(`${baseUrl}/metrics`)).text()).toContain('cloud_trigger_runs_total');
  });
});
