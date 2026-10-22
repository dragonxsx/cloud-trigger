import 'reflect-metadata';
import { readFileSync } from 'node:fs';

import { type TestHttpServer, startTestHttpServer } from '@cloud-trigger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/config.js';
import {
  respondOk,
  type TestServer,
  createTestApp,
  startTestServer,
  TEST_ENCRYPTION_KEY,
} from './support/app.js';
import { watchRunStatuses } from './support/client.js';
import { tempSqlite } from './support/databases.js';

const sqlite = tempSqlite('sqlite-e2e');
let server: TestServer;
let target: TestHttpServer;

beforeAll(async () => {
  target = await startTestHttpServer(respondOk);
  server = await startTestServer(sqlite.env);
});

afterAll(async () => {
  await server.close();
  await target.close();
  sqlite.cleanup();
});

describe('DB_DRIVER=sqlite', () => {
  it('refuses split roles at startup', () => {
    expect(() =>
      loadConfig({
        DATA_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
        DB_DRIVER: 'sqlite',
        APP_ROLE: 'api',
      }),
    ).toThrow(/APP_ROLE=all/);
  });

  it('runs a job end to end and streams its changes in-process', async () => {
    const api = server.client();
    const job = await api.jobs.create({
      name: 'on sqlite',
      trigger: { type: 'manual', config: {} },
      target: { type: 'http', config: { method: 'GET', url: target.url } },
    });
    const statuses = await watchRunStatuses(api, job.id, () => api.jobs.run({ id: job.id }));
    expect(statuses).toContain('succeeded');
  });

  it('encrypts the session secret and refuses to start with another key', async () => {
    const env = { DB_DRIVER: 'sqlite', SQLITE_PATH: sqlite.path('keyed.db'), APP_ROLE: 'all' };
    const first = await createTestApp(
      loadConfig({ ...env, DATA_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }),
    );
    expect((await first.persistence.authSettings.get())?.sessionSecret).toBe(
      'test-session-secret-test-session-secret',
    );
    await first.app.close();
    expect(readFileSync(sqlite.path('keyed.db')).includes('test-session-secret')).toBe(false);

    const otherKey = Buffer.alloc(32, 9).toString('base64');
    await expect(
      createTestApp(loadConfig({ ...env, DATA_ENCRYPTION_KEY: otherKey }), { auth: false }),
    ).rejects.toThrow(/not in DATA_ENCRYPTION_KEY/);
  });
});
