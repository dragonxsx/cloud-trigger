import 'reflect-metadata';
import { Server, createServer } from 'node:http';

import { type Contract, contract } from '@cloud-trigger/api-contract';
import type { INestApplication } from '@nestjs/common';
import { createORPCClient, isDefinedError, safe } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import type { JsonifiedClient } from '@orpc/openapi-client';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/config.js';
import { type SeedAuth, type TestApp, createTestApp } from './support/app.js';

type Client = JsonifiedClient<ContractRouterClient<Contract>>;

const API_KEYS: SeedAuth = {
  apiKeys: [
    { name: 'admin', key: 'a-key', scopes: ['admin'] },
    { name: 'writer', key: 'w-key', scopes: ['write'] },
    { name: 'reader', key: 'r-key', scopes: ['read'] },
  ],
};
let container: StartedMongoDBContainer;
let app: INestApplication;
let persistence: TestApp['persistence'];
let target: Server;
let targetUrl = '';
let baseUrl = '';
let received = 0;
void received;

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
  target = createServer((req, res) => {
    received++;
    if ((req.url ?? '').startsWith('/fail')) {
      res.writeHead(503).end();
    } else {
      res.end('{"ok":true}');
    }
  });
  targetUrl = await listen(target);

  const config = loadConfig({
    MONGO_URI: `${container.getConnectionString()}?directConnection=true`,
    MONGO_DB: 'phase2',
    WORKER_POLL_MS: '100',
    SCHEDULER_INTERVAL_MS: '200',
    NOTIFY_POLL_MS: '100',
    CALENDAR_TOKEN_SECRET: 'calendar-secret-calendar-secret-calendar-secret',
  });
  ({ app, persistence } = await createTestApp(config, { auth: API_KEYS }));
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

const failingJob = (api: Client, name: string) =>
  api.jobs.create({
    name,
    trigger: { type: 'cron', config: { expression: '0 0 1 1 *' } },
    target: { type: 'http', config: { method: 'GET', url: `${targetUrl}/fail` } },
    policy: { overlap: 'allow' },
    notifications: [
      {
        on: ['permanent_failure'],
        notifier: {
          type: 'webhook',
          config: { url: `${targetUrl}/hook`, secretHeaders: { auth: 'x' } },
        },
      },
    ],
  });

describe('Phase 2 API', { timeout: 20_000 }, () => {
  it('lists, replays and dismisses failed runs with their notifications', async () => {
    const api = client('w-key');
    const job = await failingJob(api, 'dlq');
    const runIds = [
      (await api.jobs.run({ id: job.id })).id,
      (await api.jobs.run({ id: job.id })).id,
    ];
    const inbox = () =>
      api.runs.list({ jobId: job.id, status: ['failed', 'timed_out'], acknowledged: false });
    await waitFor(async () => ((await inbox()).total === 2 ? true : undefined));

    const deliveries = await waitFor(async () => {
      const list = await api.runs.notifications({ id: runIds[0] ?? '' });

      return list.some((d) => d.status === 'delivered') ? list : undefined;
    });
    expect(deliveries[0]).toMatchObject({
      event: 'permanent_failure',
      notifier: { type: 'webhook' },
    });
    expect(deliveries[0]?.notifier.config).toMatchObject({ secretHeaders: { auth: '***' } });

    const replayed = await api.runs.replayMany({ ids: [...runIds] });
    expect(replayed.results.every((r) => r.newRunId !== null && r.error === null)).toBe(true);
    expect((await api.runs.acknowledge({ ids: [...runIds] })).acknowledged).toBe(2);
    const remaining = await inbox();
    expect(remaining.items.every((r) => !runIds.includes(r.id))).toBe(true);

    const reader = await safe(client('r-key').runs.acknowledge({ ids: [...runIds] }));
    expect(isDefinedError(reader.error) && reader.error.code).toBe('FORBIDDEN');
  });

  it('manages groups, filters jobs by group and protects non-empty groups', async () => {
    const api = client('w-key');
    const group = await api.groups.create({
      name: 'Payments',
      color: '#6b5bd2',
      defaultPolicy: { timeoutMs: 5_000 },
      defaultNotifications: [
        {
          on: ['late'],
          notifier: { type: 'slack', config: { url: 'https://hooks.slack.test/x' } },
        },
      ],
      rateLimit: { maxConcurrent: 3 },
    });
    expect(group.defaultNotifications[0]?.notifier.config).toMatchObject({ url: '***' });
    const duplicate = await safe(api.groups.create({ name: 'payments' }));
    expect(isDefinedError(duplicate.error) && duplicate.error.code).toBe('CONFLICT');

    const updated = await api.groups.update({
      ...group,
      description: 'Card processing',
      expectedVersion: group.version,
    });
    expect(updated.version).toBe(2);
    const stored = await persistence.groups.get(group.id);
    expect(stored?.defaultNotifications[0]?.notifier.config).toEqual({
      url: 'https://hooks.slack.test/x',
    });

    const job = await api.jobs.create({
      name: 'charge',
      groupId: group.id,
      trigger: { type: 'cron', config: { expression: '0 0 1 1 *' } },
      target: { type: 'http', config: { url: targetUrl } },
    });
    expect((await api.jobs.list({ groupId: group.id })).items.map((j) => j.id)).toEqual([job.id]);
    const blocked = await safe(api.groups.delete({ id: group.id }));
    expect(isDefinedError(blocked.error) && blocked.error.code).toBe('CONFLICT');
    await api.jobs.delete({ id: job.id });
    expect((await api.groups.delete({ id: group.id })).deleted).toBe(true);
  });

  it('chains jobs and reports their dependencies', async () => {
    const api = client('w-key');
    const cron = { type: 'cron', config: { expression: '0 0 1 1 *' } };
    const parent = await api.jobs.create({
      name: 'extract',
      trigger: cron,
      target: { type: 'http', config: { url: targetUrl } },
    });
    const child = await api.jobs.create({
      name: 'load',
      trigger: { type: 'after_job', config: { jobId: parent.id } },
      target: { type: 'http', config: { url: targetUrl } },
    });
    expect(child.upstreamJobIds).toEqual([parent.id]);
    expect(await api.jobs.dependencies({ id: parent.id })).toEqual({
      upstream: [],
      downstream: [{ id: child.id, name: 'load', enabled: true, pausedReason: null }],
    });
    await api.jobs.run({ id: parent.id });
    const chained = await waitFor(async () => {
      const runs = await api.runs.list({ jobId: child.id, status: ['succeeded'] });

      return runs.items[0];
    });
    expect(chained.reason).toBe('chained');
    expect(chained.parentRunId).not.toBeNull();

    const cycle = await safe(
      api.jobs.update({
        ...parent,
        trigger: { type: 'after_job', config: { jobId: child.id }, jitterMs: 0 },
        expectedVersion: parent.version,
      }),
    );
    expect(
      isDefinedError(cycle.error) &&
        cycle.error.code === 'INVALID_CONFIG' &&
        cycle.error.data.issues[0]?.path,
    ).toBe('trigger.config.jobId');
  });

  it('backfills idempotently', async () => {
    const api = client('w-key');
    const job = await api.jobs.create({
      name: 'hourly',
      trigger: { type: 'cron', config: { expression: '0 * * * *' } },
      target: { type: 'http', config: { url: targetUrl } },
      policy: { overlap: 'allow' },
    });
    const range = { id: job.id, from: '2026-02-01T00:00:00Z', to: '2026-02-01T02:30:00Z' };
    const preview = await api.jobs.backfill({ ...range, dryRun: true });
    expect(preview).toMatchObject({ created: [], duplicates: 0, truncated: false });
    expect(preview.fireTimes).toHaveLength(3);
    const first = await api.jobs.backfill(range);
    const second = await api.jobs.backfill(range);
    expect(first.created).toHaveLength(3);
    expect(second).toMatchObject({ created: [], duplicates: 3 });
    const runs = await api.runs.list({ jobId: job.id, reason: 'backfill' });
    expect(runs.items.map((r) => r.id).toSorted()).toEqual([...first.created].toSorted());
    const reader = await safe(client('r-key').jobs.backfill(range));
    expect(isDefinedError(reader.error) && reader.error.code).toBe('FORBIDDEN');
  });

  it('explains a paused job', async () => {
    const api = client('w-key');
    const job = await api.jobs.create({
      name: 'explained',
      trigger: { type: 'cron', config: { expression: '0 0 1 1 *' } },
      target: { type: 'http', config: { url: targetUrl } },
    });
    await api.jobs.pause({ id: job.id, reason: 'Maintenance window' });
    const explained = await api.jobs.explain({ id: job.id });
    expect(explained.narrative[0]).toMatch(/^Paused since .*: Maintenance window\./);
    expect(explained.decisions[0]).toMatchObject({
      decision: 'paused',
      detail: 'Maintenance window',
    });
    expect(explained.nextFireAt).toBeTypeOf('string');
  });

  it('exports YAML with redacted secrets and imports it back (admin only)', async () => {
    const admin = client('a-key');
    await admin.jobs.create({
      name: 'yaml-export',
      tags: ['gitops'],
      trigger: { type: 'cron', config: { expression: '0 0 1 1 *' } },
      target: {
        type: 'http',
        config: { url: targetUrl, secretHeaders: { authorization: 'Bearer real-token' } },
      },
    });
    const forbidden = await safe(client('w-key').jobs.export({ tag: 'gitops' }));
    expect(isDefinedError(forbidden.error) && forbidden.error.code).toBe('FORBIDDEN');

    const file = await admin.jobs.export({ tag: 'gitops' });
    const text = await file.text();
    expect(text).toContain('name: yaml-export');
    expect(text).toContain('authorization: "***"');
    expect(text).not.toContain('real-token');

    const unchanged = await admin.jobs.import({ yaml: text, dryRun: false });
    expect(unchanged).toMatchObject({ unchanged: ['yaml-export'], issues: [] });
    const edited = await admin.jobs.import({
      yaml: text.replace(/^description: .*$/m, 'description: from git'),
      dryRun: false,
    });
    expect(edited.updated).toEqual(['yaml-export']);
    const [stored] = await persistence.jobs.findByName('yaml-export');
    expect(stored?.description).toBe('from git');
    expect(stored?.target.config).toMatchObject({
      secretHeaders: { authorization: 'Bearer real-token' },
    });

    const broken = await admin.jobs.import({ yaml: 'name: [unclosed', dryRun: true });
    expect(broken.issues[0]?.path).toBe('yaml');
  });

  it('serves status badges and an iCal feed behind read access', async () => {
    const api = client('w-key');
    const job = await api.jobs.create({
      name: 'badged',
      tags: ['calendar'],
      trigger: { type: 'cron', config: { expression: '0 */6 * * *' } },
      target: { type: 'http', config: { url: targetUrl } },
    });
    const badgeUrl = `${baseUrl}/badges/jobs/${job.id}.svg`;
    expect((await fetch(badgeUrl)).status).toBe(401);
    const empty = await fetch(badgeUrl, { headers: { 'x-api-key': 'r-key' } });
    expect(empty.status).toBe(200);
    expect(empty.headers.get('content-type')).toContain('image/svg+xml');
    expect(empty.headers.get('cache-control')).toBe('private, no-store');
    expect(await empty.text()).toContain('no runs yet');

    await api.jobs.run({ id: job.id });
    await waitFor(async () => {
      const runs = await api.runs.list({ jobId: job.id, status: ['succeeded'] });

      return runs.total > 0 ? true : undefined;
    });
    const succeeded = await (await fetch(badgeUrl, { headers: { 'x-api-key': 'r-key' } })).text();
    expect(succeeded).toContain('succeeded');
    expect(succeeded).toContain('#0ca30c');

    expect((await fetch(`${baseUrl}/calendar.ics?tag=calendar`)).status).toBe(401);
    const { url } = await client('r-key').calendar.token({});
    const feedUrl = new URL(url);
    const feed = await fetch(
      `${baseUrl}/calendar.ics?tag=calendar&days=2&token=${feedUrl.searchParams.get('token') ?? ''}`,
    );
    expect(feed.status).toBe(200);
    const ics = await feed.text();
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics.match(/BEGIN:VEVENT/g)?.length ?? 0).toBeGreaterThanOrEqual(7);
    expect(ics).toContain('SUMMARY:badged');
    const forged = await fetch(`${baseUrl}/calendar.ics?token=forged.token`);
    expect(forged.status).toBe(401);
  });

  it('tells the UI how to sign in without requiring credentials', async () => {
    expect(await client().auth.config({})).toEqual({
      setupRequired: false,
      local: true,
      oidc: null,
      apiKeys: true,
      anonymous: false,
    });
    const anonymous = await safe(client().auth.me({}));
    expect(isDefinedError(anonymous.error) && anonymous.error.code).toBe('UNAUTHORIZED');
  });
});
