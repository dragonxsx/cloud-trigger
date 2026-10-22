import 'reflect-metadata';
import { type TestHttpServer, startTestHttpServer } from '@cloud-trigger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type TestServer, startTestServer } from './support/app.js';
import { errorCode } from './support/client.js';
import { tempSqlite } from './support/databases.js';

const SECRET = 'Bearer e2e-extract-secret';
const sqlite = tempSqlite('extract-e2e');
let server: TestServer;
let target: TestHttpServer;

const client = (apiKey: string) => server.client(apiKey);

beforeAll(async () => {
  target = await startTestHttpServer((_req, res) => {
    res.writeHead(200).end('{}');
  });
  server = await startTestServer(sqlite.env, {
    auth: {
      apiKeys: [
        { name: 'writer', key: 'w-key', scopes: ['write'] },
        { name: 'reader', key: 'r-key', scopes: ['read'] },
      ],
    },
  });
});

afterAll(async () => {
  await server.close();
  await target.close();
  sqlite.cleanup();
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

    expect(
      await errorCode(
        client('w-key').jobs.extractConnection({
          id: job.id,
          slot: { kind: 'target' },
          expectedVersion: reloaded.version,
        }),
      ),
    ).toBe('INVALID_CONFIG');
  });

  it('rejects read-only keys and stale versions', async () => {
    const job = await createJob();
    expect(
      await errorCode(
        client('r-key').jobs.extractConnection({
          id: job.id,
          slot: { kind: 'target' },
          expectedVersion: job.version,
        }),
      ),
    ).toBe('FORBIDDEN');

    expect(
      await errorCode(
        client('w-key').jobs.extractConnection({
          id: job.id,
          slot: { kind: 'target' },
          expectedVersion: job.version + 1,
        }),
      ),
    ).toBe('CONFLICT');
  });
});
