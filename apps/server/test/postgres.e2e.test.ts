import 'reflect-metadata';
import { Server, createServer } from 'node:http';

import { type Contract, contract } from '@cloud-trigger/api-contract';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import type { JsonifiedClient } from '@orpc/openapi-client';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type AppContext, createAppContext } from '../src/app-context.js';
import { AppModule } from '../src/app.module.js';
import { loadConfig } from '../src/config.js';

type Client = JsonifiedClient<ContractRouterClient<Contract>>;

let container: StartedPostgreSqlContainer;
let app: INestApplication;
let ctx: AppContext;
let target: Server;
let targetUrl = '';
let baseUrl = '';

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
  container = await new PostgreSqlContainer('postgres:18-alpine').start();
  target = createServer((_req, res) => res.end('{"ok":true}'));
  targetUrl = await listen(target);
  const config = loadConfig({
    DB_DRIVER: 'postgres',
    POSTGRES_URL: container.getConnectionUri(),
    AUTH_DISABLED: 'true',
    WORKER_POLL_MS: '100',
    SCHEDULER_INTERVAL_MS: '200',
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
}, 180_000);

afterAll(async () => {
  await app.close();
  await container.stop();
  await new Promise<void>((resolve) => target.close(() => resolve()));
});

describe('DB_DRIVER=postgres', () => {
  it('runs jobs and streams run changes through LISTEN/NOTIFY', async () => {
    const api: Client = createORPCClient(new OpenAPILink(contract, { url: baseUrl }));
    expect(await (await fetch(`${baseUrl}/health/ready`)).json()).toMatchObject({
      status: 'ok',
    });
    const job = await api.jobs.create({
      name: 'on postgres',
      trigger: { type: 'manual', config: {} },
      target: { type: 'http', config: { method: 'GET', url: targetUrl } },
    });

    const controller = new AbortController();
    const statuses: string[] = [];
    const stream = await api.runs.stream({ jobId: job.id }, { signal: controller.signal });
    const watching = (async () => {
      for await (const run of stream) {
        statuses.push(run.status);
        if (run.status === 'succeeded') {
          controller.abort();
        }
      }
    })().catch(() => undefined);

    await api.jobs.run({ id: job.id });
    await Promise.race([watching, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    controller.abort();
    expect(statuses).toContain('succeeded');

    const summarise = () =>
      api.analytics.summary({
        from: new Date(Date.now() - 60_000).toISOString(),
        to: new Date(Date.now() + 60_000).toISOString(),
      });
    let summary = await summarise();
    for (let i = 0; i < 50 && summary.total === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      summary = await summarise();
    }
    expect(summary.total).toBe(1);
    expect(summary.p50Ms).not.toBeNull();
  });
});
