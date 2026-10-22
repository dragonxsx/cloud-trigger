import 'reflect-metadata';
import { type TestHttpServer, startTestHttpServer } from '@cloud-trigger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { respondOk, type TestServer, startTestServer } from './support/app.js';
import { errorCode, rejection, waitFor } from './support/client.js';
import { mongoEnv } from './support/databases.js';

let server: TestServer;
let target: TestHttpServer;

beforeAll(async () => {
  target = await startTestHttpServer(respondOk);
  server = await startTestServer(mongoEnv('api'), {
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
});

describe('API e2e (typed oRPC client)', () => {
  it('rejects anonymous and under-scoped callers with typed errors', async () => {
    const { client } = server;
    expect(await errorCode(client().jobs.list({}))).toBe('UNAUTHORIZED');
    expect(
      await errorCode(
        client('r-key').jobs.create({
          name: 'x',
          trigger: { type: 'once', config: {} },
          target: { type: 'http', config: {} },
        }),
      ),
    ).toBe('FORBIDDEN');
    expect((await client('r-key').auth.me({})).scopes).toEqual(['read']);
  });

  it('tells the UI how to sign in without requiring credentials', async () => {
    const { client } = server;
    expect(await client().auth.config({})).toEqual({
      setupRequired: false,
      local: true,
      oidc: null,
      apiKeys: true,
      anonymous: false,
    });
    expect(await errorCode(client().auth.me({}))).toBe('UNAUTHORIZED');
  });

  it('creates a job, runs it on demand, and reports results', async () => {
    const api = server.client('w-key');
    expect(
      await rejection(
        api.jobs.create({
          name: 'bad',
          trigger: { type: 'cron', config: { expression: 'nope' } },
          target: { type: 'http', config: { url: target.url } },
        }),
      ),
    ).toMatchObject({
      code: 'INVALID_CONFIG',
      data: { issues: [{ path: 'trigger.config.expression' }] },
    });

    const job = await api.jobs.create({
      name: 'e2e',
      trigger: { type: 'cron', config: { expression: '0 0 1 1 *' } },
      target: {
        type: 'http',
        config: { method: 'POST', url: `${target.url}/hook`, signing: { secret: 'shh' } },
      },
    });
    expect(job.createdAt).toBeTypeOf('string');
    expect(job.target.config).toMatchObject({ signing: { secret: '***' } });

    const pending = await api.jobs.run({ id: job.id });
    expect(pending.status).toBe('pending');
    await waitFor(async () => {
      const run = await api.runs.get({ id: pending.id });

      return run.status === 'succeeded' ? run : undefined;
    });
    expect(target.requests).toHaveLength(1);

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

  it('sorts the whole job list on the server', async () => {
    const api = server.client('w-key');
    for (const name of ['sort-b', 'Sort-a', 'sort-c']) {
      await api.jobs.create({
        name,
        enabled: false,
        trigger: { type: 'cron', config: { expression: '0 0 1 1 *' } },
        target: { type: 'http', config: { url: target.url } },
      });
    }

    const page = await api.jobs.list({ search: 'sort-', sort: 'name', order: 'desc', limit: 2 });
    expect(page.items.map((j) => j.name)).toEqual(['sort-c', 'sort-b']);
    expect(page.total).toBe(3);
    const next = await api.jobs.list({ search: 'sort-', sort: 'name', limit: 2, offset: 2 });
    expect(next.items.map((j) => j.name)).toEqual(['sort-c']);

    expect(await errorCode(api.jobs.list({ sort: 'name', cursor: page.items[0]?.id ?? '' }))).toBe(
      'BAD_REQUEST',
    );
  });

  it('serves providers, OpenAPI, health and metrics', async () => {
    const { baseUrl, client } = server;
    const providers = await client('r-key').providers.list({ kind: 'target' });
    expect(providers.map((p) => p.type)).toContain('http');
    const spec = await fetch(`${baseUrl}/api/openapi.json`);
    expect(spec.status).toBe(200);
    expect((await fetch(`${baseUrl}/health/ready`)).status).toBe(200);
    expect(await (await fetch(`${baseUrl}/metrics`)).text()).toContain('cloud_trigger_runs_total');
  });
});
