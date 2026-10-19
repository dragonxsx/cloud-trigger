import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Contract, contract } from '@cloud-trigger/api-contract';
import type { INestApplication } from '@nestjs/common';
import { createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import type { JsonifiedClient } from '@orpc/openapi-client';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/config.js';
import { createTestApp } from './support/app.js';

type Client = JsonifiedClient<ContractRouterClient<Contract>>;

const dir = mkdtempSync(join(tmpdir(), 'ct-sqlite-e2e-'));
let app: INestApplication;
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
  target = createServer((_req, res) => res.end('{"ok":true}'));
  targetUrl = await listen(target);
  const config = loadConfig({
    DB_DRIVER: 'sqlite',
    SQLITE_PATH: join(dir, 'app.db'),
    WORKER_POLL_MS: '100',
    SCHEDULER_INTERVAL_MS: '200',
  });
  ({ app } = await createTestApp(config));
  app.enableShutdownHooks();
  await app.init();
  const http: unknown = app.getHttpServer();
  if (!(http instanceof Server)) {
    throw new Error('Expected a node:http server');
  }
  baseUrl = await listen(http);
}, 60_000);

afterAll(async () => {
  await app.close();
  await new Promise<void>((resolve) => target.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe('DB_DRIVER=sqlite', () => {
  it('refuses split roles at startup', () => {
    expect(() => loadConfig({ DB_DRIVER: 'sqlite', APP_ROLE: 'api' })).toThrow(/APP_ROLE=all/);
  });

  it('runs a job end to end and streams its changes in-process', async () => {
    const api: Client = createORPCClient(new OpenAPILink(contract, { url: baseUrl }));
    const job = await api.jobs.create({
      name: 'on sqlite',
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
  });
});
