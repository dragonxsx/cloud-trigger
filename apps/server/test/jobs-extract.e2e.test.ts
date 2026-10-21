import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Contract, contract } from '@cloud-trigger/api-contract';
import { type TestHttpServer, startTestHttpServer } from '@cloud-trigger/testing';
import type { INestApplication } from '@nestjs/common';
import { createORPCClient, isDefinedError, safe } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import type { JsonifiedClient } from '@orpc/openapi-client';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/config.js';
import { createTestApp, TEST_ENCRYPTION_KEY } from './support/app.js';

type Client = JsonifiedClient<ContractRouterClient<Contract>>;

const SECRET = 'Bearer e2e-extract-secret';
const dir = mkdtempSync(join(tmpdir(), 'ct-extract-e2e-'));
let app: INestApplication;
let target: TestHttpServer;
let baseUrl = '';

const client = (apiKey: string): Client =>
  createORPCClient(new OpenAPILink(contract, { url: baseUrl, headers: { 'x-api-key': apiKey } }));

beforeAll(async () => {
  target = await startTestHttpServer((_req, res) => {
    res.writeHead(200).end('{}');
  });
  const config = loadConfig({
    DATA_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    DB_DRIVER: 'sqlite',
    SQLITE_PATH: join(dir, 'app.db'),
    WORKER_POLL_MS: '100',
    SCHEDULER_INTERVAL_MS: '200',
  });
  ({ app } = await createTestApp(config, {
    auth: {
      apiKeys: [
        { name: 'writer', key: 'w-key', scopes: ['write'] },
        { name: 'reader', key: 'r-key', scopes: ['read'] },
      ],
    },
  }));
  app.enableShutdownHooks();
  await app.init();
  const http: unknown = app.getHttpServer();
  if (!(http instanceof Server)) {
    throw new Error('Expected a node:http server');
  }
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (address === null || typeof address === 'string') {
    throw new Error('tcp');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 60_000);

afterAll(async () => {
  await app.close();
  await target.close();
  rmSync(dir, { recursive: true, force: true });
});

const createJob = () =>
  client('w-key').jobs.create({
    name: 'Extract me',
    trigger: { type: 'manual', config: {} },
    target: {
      type: 'http',
      config: { url: `${target.url}/v1/ping`, secretHeaders: { authorization: SECRET } },
    },
  });

describe('jobs.extractConnection', () => {
  it('previews with secrets redacted, then commits', async () => {
    const job = await createJob();
    const preview = await client('w-key').jobs.extractConnection({
      id: job.id,
      slot: { kind: 'target' },
      key: 'pinger',
      expectedVersion: job.version,
    });
    expect(preview.dryRun).toBe(true);
    expect(JSON.stringify(preview)).not.toContain(SECRET);
    expect(preview.connection.config).toMatchObject({ secretHeaders: { authorization: '***' } });

    const saved = await client('w-key').jobs.extractConnection({
      id: job.id,
      slot: { kind: 'target' },
      key: 'pinger',
      expectedVersion: job.version,
      dryRun: false,
    });
    expect(saved.job.target.connection).toEqual({ key: 'pinger', endpoint: 'extract-me' });
    const reloaded = await client('r-key').jobs.get({ id: job.id });
    expect(reloaded.target).toMatchObject({ connection: { key: 'pinger' }, config: {} });
    expect((await client('r-key').connections.get({ key: 'pinger' })).endpoints).toHaveLength(1);

    const again = await safe(
      client('w-key').jobs.extractConnection({
        id: job.id,
        slot: { kind: 'target' },
        expectedVersion: reloaded.version,
      }),
    );
    expect(isDefinedError(again.error) && again.error.code).toBe('INVALID_CONFIG');
  });

  it('rejects read-only keys and stale versions', async () => {
    const job = await createJob();
    const reader = await safe(
      client('r-key').jobs.extractConnection({
        id: job.id,
        slot: { kind: 'target' },
        expectedVersion: job.version,
      }),
    );
    expect(isDefinedError(reader.error) && reader.error.code).toBe('FORBIDDEN');

    const stale = await safe(
      client('w-key').jobs.extractConnection({
        id: job.id,
        slot: { kind: 'target' },
        expectedVersion: job.version + 1,
      }),
    );
    expect(isDefinedError(stale.error) && stale.error.code).toBe('CONFLICT');
  });
});
