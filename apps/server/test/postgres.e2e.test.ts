import 'reflect-metadata';
import { type TestHttpServer, startTestHttpServer } from '@cloud-trigger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { respondOk, type TestServer, startTestServer } from './support/app.js';
import { waitFor, watchRunStatuses } from './support/client.js';
import { type TestPostgres, startPostgres } from './support/databases.js';

let postgres: TestPostgres;
let server: TestServer;
let target: TestHttpServer;

beforeAll(async () => {
  postgres = await startPostgres();
  target = await startTestHttpServer(respondOk);
  server = await startTestServer(postgres.env);
});

afterAll(async () => {
  await server.close();
  await postgres.stop();
  await target.close();
});

describe('DB_DRIVER=postgres', () => {
  it('runs jobs and streams run changes through LISTEN/NOTIFY', async () => {
    const api = server.client();
    expect(await (await fetch(`${server.baseUrl}/health/ready`)).json()).toMatchObject({
      status: 'ok',
    });
    const job = await api.jobs.create({
      name: 'on postgres',
      trigger: { type: 'manual', config: {} },
      target: { type: 'http', config: { method: 'GET', url: target.url } },
    });

    const statuses = await watchRunStatuses(api, job.id, () => api.jobs.run({ id: job.id }));
    expect(statuses).toContain('succeeded');

    const summary = await waitFor(async () => {
      const current = await api.analytics.summary({
        from: new Date(Date.now() - 60_000).toISOString(),
        to: new Date(Date.now() + 60_000).toISOString(),
      });

      return current.total > 0 ? current : undefined;
    }, 5_000);
    expect(summary.total).toBe(1);
    expect(summary.p50Ms).not.toBeNull();
  });
});
