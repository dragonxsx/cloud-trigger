import 'reflect-metadata';
import { type TestHttpServer, startTestHttpServer } from '@cloud-trigger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { API_KEYS, type TestServer, startTestServer } from './support/app.js';
import { type Client, errorCode, rejection, waitFor } from './support/client.js';
import { mongoEnv } from './support/databases.js';

let server: TestServer;
let target: TestHttpServer;

beforeAll(async () => {
  target = await startTestHttpServer((req, res) => {
    if ((req.url ?? '').startsWith('/fail')) {
      res.writeHead(503).end();
    } else {
      res.end('{"ok":true}');
    }
  });
  server = await startTestServer(
    {
      ...mongoEnv('operations'),
      CALENDAR_TOKEN_SECRET: 'calendar-secret-calendar-secret-calendar-secret',
    },
    { auth: API_KEYS },
  );
});

afterAll(async () => {
  await server.close();
  await target.close();
});

const failingJob = (api: Client, name: string) =>
  api.jobs.create({
    name,
    trigger: { type: 'cron', config: { expression: '0 0 1 1 *' } },
    target: { type: 'http', config: { method: 'GET', url: `${target.url}/fail` } },
    policy: { overlap: 'allow' },
    notifications: [
      {
        on: ['permanent_failure'],
        notifier: {
          type: 'webhook',
          config: { url: `${target.url}/hook`, secretHeaders: { auth: 'x' } },
        },
      },
    ],
  });

describe('failed runs', { timeout: 20_000 }, () => {
  it('lists, replays and dismisses failed runs with their notifications', async () => {
    const api = server.client('w-key');
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

    expect(await errorCode(server.client('r-key').runs.acknowledge({ ids: [...runIds] }))).toBe(
      'FORBIDDEN',
    );
  });
});

describe('groups', () => {
  it('manages groups, filters jobs by group and protects non-empty groups', async () => {
    const api = server.client('w-key');
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
    expect(await errorCode(api.groups.create({ name: 'payments' }))).toBe('CONFLICT');

    const updated = await api.groups.update({
      ...group,
      description: 'Card processing',
      expectedVersion: group.version,
    });
    expect(updated.version).toBe(2);
    const stored = await server.persistence.groups.get(group.id);
    expect(stored?.defaultNotifications[0]?.notifier.config).toEqual({
      url: 'https://hooks.slack.test/x',
    });

    const job = await api.jobs.create({
      name: 'charge',
      groupId: group.id,
      trigger: { type: 'cron', config: { expression: '0 0 1 1 *' } },
      target: { type: 'http', config: { url: target.url } },
    });
    expect((await api.jobs.list({ groupId: group.id })).items.map((j) => j.id)).toEqual([job.id]);
    expect(await errorCode(api.groups.delete({ id: group.id }))).toBe('CONFLICT');
    await api.jobs.delete({ id: job.id });
    expect((await api.groups.delete({ id: group.id })).deleted).toBe(true);
  });
});

describe('job scheduling', { timeout: 20_000 }, () => {
  it('chains jobs and reports their dependencies', async () => {
    const api = server.client('w-key');
    const cron = { type: 'cron', config: { expression: '0 0 1 1 *' } };
    const parent = await api.jobs.create({
      name: 'extract',
      trigger: cron,
      target: { type: 'http', config: { url: target.url } },
    });
    const child = await api.jobs.create({
      name: 'load',
      trigger: { type: 'after_job', config: { jobId: parent.id } },
      target: { type: 'http', config: { url: target.url } },
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

    expect(
      await rejection(
        api.jobs.update({
          ...parent,
          trigger: { type: 'after_job', config: { jobId: child.id }, jitterMs: 0 },
          expectedVersion: parent.version,
        }),
      ),
    ).toMatchObject({
      code: 'INVALID_CONFIG',
      data: { issues: [{ path: 'trigger.config.jobId' }] },
    });
  });

  it('backfills idempotently', async () => {
    const api = server.client('w-key');
    const job = await api.jobs.create({
      name: 'hourly',
      trigger: { type: 'cron', config: { expression: '0 * * * *' } },
      target: { type: 'http', config: { url: target.url } },
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
    expect(await errorCode(server.client('r-key').jobs.backfill(range))).toBe('FORBIDDEN');
  });

  it('explains a paused job', async () => {
    const api = server.client('w-key');
    const job = await api.jobs.create({
      name: 'explained',
      trigger: { type: 'cron', config: { expression: '0 0 1 1 *' } },
      target: { type: 'http', config: { url: target.url } },
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
});

describe('YAML export and import', () => {
  it('exports YAML with redacted secrets and imports it back (admin only)', async () => {
    const admin = server.client('a-key');
    await admin.jobs.create({
      name: 'yaml-export',
      tags: ['gitops'],
      trigger: { type: 'cron', config: { expression: '0 0 1 1 *' } },
      target: {
        type: 'http',
        config: { url: target.url, secretHeaders: { authorization: 'Bearer real-token' } },
      },
    });
    expect(await errorCode(server.client('w-key').jobs.export({ tag: 'gitops' }))).toBe(
      'FORBIDDEN',
    );

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
    const [stored] = await server.persistence.jobs.findByName('yaml-export');
    expect(stored?.description).toBe('from git');
    expect(stored?.target.config).toMatchObject({
      secretHeaders: { authorization: 'Bearer real-token' },
    });

    const broken = await admin.jobs.import({ yaml: 'name: [unclosed', dryRun: true });
    expect(broken.issues[0]?.path).toBe('yaml');
  });
});

describe('status badges and calendar feed', { timeout: 20_000 }, () => {
  it('serves status badges and an iCal feed behind read access', async () => {
    const { baseUrl, client } = server;
    const api = client('w-key');
    const job = await api.jobs.create({
      name: 'badged',
      tags: ['calendar'],
      trigger: { type: 'cron', config: { expression: '0 */6 * * *' } },
      target: { type: 'http', config: { url: target.url } },
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
});
