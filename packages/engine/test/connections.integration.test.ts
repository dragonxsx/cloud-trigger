import { setTimeout as sleep } from 'node:timers/promises';

import {
  type Clock,
  type JobId,
  type Persistence,
  ProviderRegistry,
  defineConnection,
  defineInlineConnectedEventSource,
  mapSecretResolver,
  NotificationRule,
  newDeliveries,
  silentLogger,
} from '@cloud-trigger/core';
import { builtinProviders, createFanoutTarget } from '@cloud-trigger/providers-builtin';
import { type TestHttpServer, startTestHttpServer } from '@cloud-trigger/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ConnectionService,
  ConsumerSupervisor,
  EventIngestor,
  GroupService,
  JobService,
  Worker,
} from '../src/index.js';
import { type TestDatabase, startTestDatabase } from './databases.js';

let database: TestDatabase;
let db: Persistence;
let server: TestHttpServer;

const clock: Clock = { now: () => new Date('2026-03-01T00:00:00.000Z') };
const registry = new ProviderRegistry().use(builtinProviders);
registry.register(createFanoutTarget(registry));

const broker = defineConnection({
  type: 'broker',
  displayName: 'Broker',
  configSchema: z.object({ url: z.url() }),
});
const subscriptions: string[] = [];
const tail = defineInlineConnectedEventSource({
  type: 'tail',
  displayName: 'Tail',
  connection: broker,
  configSchema: z.object({
    ...broker.configSchema.partial().shape,
    topic: z.string().min(1),
    group: z.string().default('main'),
  }),
  exclusive: false,
  describe: (config) => `On ${config.topic}`,
  async subscribe(config, { signal, connection }) {
    subscriptions.push(`${connection.config.url}/${config.topic}#${config.group}`);
    await sleep(60_000, undefined, { signal }).catch(() => undefined);
  },
});
registry.register(broker, tail);
const secrets = mapSecretResolver({ BILLING_TOKEN: 'tok' });

beforeAll(async () => {
  database = await startTestDatabase('connections');
  db = database.persistence;
  server = await startTestHttpServer((req, res) => {
    res.writeHead(req.headers.authorization === 'Bearer tok' ? 200 : 401).end('{}');
  });
}, 120_000);

afterAll(async () => {
  await database.stop();
  await server.close();
});

beforeEach(async () => {
  subscriptions.length = 0;
  await database.clear([
    'jobs',
    'job_tags',
    'job_upstreams',
    'job_connections',
    'groups',
    'group_connections',
    'connections',
    'runs',
    'notifications_outbox',
  ]);
});

const connections = () => new ConnectionService({ ...db, registry, secrets, clock });
const groups = () => new GroupService({ ...db, registry, clock });
const jobs = () => new JobService({ ...db, registry, clock, logger: silentLogger, listeners: [] });
const worker = () =>
  new Worker(
    { ...db, registry, secrets, clock, logger: silentLogger, listeners: [] },
    {
      workerId: 'w1',
      concurrency: 2,
      pollIntervalMs: 50,
      leaseMs: 30_000,
      bufferedRequeueDelayMs: 1_000,
    },
  );

const consumers = () =>
  new ConsumerSupervisor(
    {
      ...db,
      registry,
      secrets,
      clock,
      logger: silentLogger,
      ingestor: new EventIngestor({ ...db, registry, secrets, clock, logger: silentLogger }),
    },
    { ownerId: 'c1', intervalMs: 50, leaseMs: 1_000, restartDelayMs: 20 },
  );

const billing = (baseUrl: string, endpoints: unknown[] = [charge]) => ({
  key: 'billing',
  name: 'Billing API',
  type: 'http',
  config: { baseUrl, auth: { type: 'bearer', token: '{{secret:BILLING_TOKEN}}' } },
  endpoints,
});
const charge = {
  key: 'charge',
  target: { type: 'http', config: { method: 'POST', url: '/charges' } },
};
const refund = {
  key: 'refund',
  target: { type: 'http', config: { method: 'POST', url: '/refunds' } },
};

const chargeJob = {
  name: 'nightly charge',
  trigger: { type: 'manual', config: {} },
  target: {
    type: 'http',
    connection: { key: 'billing', endpoint: 'charge' },
    config: { query: { dry: '1' } },
  },
};

const runOnce = async (jobId: JobId) => {
  await jobs().runNow(jobId);
  const w = worker();
  await w.tick();
  await w.stop();
  const [run] = (await db.runs.list({ jobId, limit: 10 })).items;

  return run;
};

describe('connections', () => {
  it('runs a job on a named endpoint with the connection credentials', async () => {
    (await connections().create(billing(`${server.url}/v1`)))._unsafeUnwrap();
    const job = (await jobs().create(chargeJob))._unsafeUnwrap();
    expect(job.connectionRefs).toEqual([{ key: 'billing', endpoint: 'charge' }]);

    const run = await runOnce(job.id);
    expect(run?.status).toBe('succeeded');
    expect(server.requests.at(-1)).toMatchObject({ method: 'POST', url: '/v1/charges?dry=1' });
    expect(run && 'result' in run ? run.result?.metadata : undefined).toMatchObject({
      connection: { key: 'billing', endpoint: 'charge', version: 1 },
    });
  });

  it('applies connection changes to the next run', async () => {
    const created = (await connections().create(billing(`${server.url}/v1`)))._unsafeUnwrap();
    const job = (await jobs().create(chargeJob))._unsafeUnwrap();
    (
      await connections().update('billing', billing(`${server.url}/v2`), created.version)
    )._unsafeUnwrap();
    await runOnce(job.id);
    expect(server.requests.at(-1)?.url).toBe('/v2/charges?dry=1');
  });

  it('rejects jobs that reference missing connections or endpoints', async () => {
    const missing = await jobs().create(chargeJob);
    expect(missing._unsafeUnwrapErr().issues.map((i) => i.path)).toEqual(['target.connection.key']);
    (await connections().create(billing(server.url)))._unsafeUnwrap();
    const noEndpoint = await jobs().create({
      ...chargeJob,
      target: { ...chargeJob.target, connection: { key: 'billing', endpoint: 'nope' } },
    });
    expect(noEndpoint._unsafeUnwrapErr().issues.map((i) => i.path)).toEqual([
      'target.connection.endpoint',
    ]);
  });

  it('validates endpoints against the connection', async () => {
    const invalid = await connections().create(
      billing(server.url, [
        { key: 'bad', target: { type: 'http', config: { url: 'https://evil.test' } } },
      ]),
    );
    expect(invalid._unsafeUnwrapErr()).toMatchObject({
      code: 'invalid_config',
      issues: [{ path: 'endpoints.0.target.config.url' }],
    });
    const wrongType = await connections().create(
      billing(server.url, [{ key: 'raw', target: { type: 'fanout', config: { targets: [] } } }]),
    );
    expect(wrongType.isErr()).toBe(true);
  });

  it('refuses updates that break jobs and deletes while in use', async () => {
    const created = (
      await connections().create(billing(server.url, [charge, refund]))
    )._unsafeUnwrap();
    const job = (await jobs().create(chargeJob))._unsafeUnwrap();

    const broken = await connections().update(
      'billing',
      billing(server.url, [refund]),
      created.version,
    );
    const brokenError = broken._unsafeUnwrapErr();
    expect(brokenError.code).toBe('invalid_config');
    expect(brokenError.code === 'invalid_config' && brokenError.issues).toEqual([
      {
        path: 'endpoints',
        message:
          'Job "nightly charge" would break: target.connection.endpoint: Connection "billing" has no endpoint "charge"',
      },
    ]);
    const renamed = await connections().update(
      'billing',
      { ...billing(server.url), key: 'other' },
      1,
    );
    expect(renamed._unsafeUnwrapErr()).toMatchObject({ issues: [{ path: 'key' }] });

    expect((await connections().usages('billing')).jobs.map((j) => j.id)).toEqual([job.id]);
    expect((await connections().delete('billing'))._unsafeUnwrapErr()).toMatchObject({
      code: 'connection_in_use',
      jobIds: [job.id],
    });
    expect(await jobs().delete(job.id)).toBeTruthy();
    expect((await connections().delete('billing')).isOk()).toBe(true);
    expect((await connections().delete('billing'))._unsafeUnwrapErr().code).toBe('not_found');
  });

  it('tracks fan-out children and tests a connection', async () => {
    (await connections().create(billing(server.url)))._unsafeUnwrap();
    const job = (
      await jobs().create({
        name: 'fan',
        trigger: { type: 'manual', config: {} },
        target: {
          type: 'fanout',
          config: {
            targets: [
              { type: 'http', connection: { key: 'billing', endpoint: 'charge' }, config: {} },
            ],
          },
        },
      })
    )._unsafeUnwrap();
    expect(job.connectionRefs).toEqual([{ key: 'billing', endpoint: 'charge' }]);
    expect((await runOnce(job.id))?.status).toBe('succeeded');

    const tested = await connections().test({ type: 'http', config: billing(server.url).config });
    expect(tested._unsafeUnwrap()._unsafeUnwrap().message).toMatch(/HTTP 200/);
    const rejected = await connections().test({ type: 'http', config: { baseUrl: server.url } });
    expect(rejected._unsafeUnwrap()._unsafeUnwrapErr().message).toMatch(/rejected/);
  });

  describe('event sources', () => {
    const events = (endpoints: unknown[] = [orders]) => ({
      key: 'events',
      type: 'broker',
      config: { url: 'https://broker.test' },
      endpoints,
    });
    const orders = { key: 'orders', source: { type: 'tail', config: { topic: 'orders' } } };
    const ordersJob = {
      name: 'on order',
      trigger: {
        type: 'tail',
        connection: { key: 'events', endpoint: 'orders' },
        config: { group: 'billing' },
      },
      target: { type: 'http', connection: { key: 'billing' }, config: { url: '/orders' } },
    };
    it('subscribes over the connection and resubscribes when it changes', async () => {
      (await connections().create(billing(server.url)))._unsafeUnwrap();
      const created = (await connections().create(events()))._unsafeUnwrap();
      const job = (await jobs().create(ordersJob))._unsafeUnwrap();
      expect(job.connectionRefs).toEqual([
        { key: 'events', endpoint: 'orders' },
        { key: 'billing' },
      ]);
      expect(job.eventSource).toBe('tail');

      const consumer = consumers();
      try {
        await consumer.tick();
        await consumer.tick();
        expect(subscriptions).toEqual(['https://broker.test/orders#billing']);

        (
          await connections().update(
            'events',
            { ...events(), config: { url: 'https://broker-2.test' } },
            created.version,
          )
        )._unsafeUnwrap();
        await consumer.tick();
        expect(subscriptions).toEqual([
          'https://broker.test/orders#billing',
          'https://broker-2.test/orders#billing',
        ]);
      } finally {
        await consumer.stop();
      }
    });

    it('validates source endpoints against the connection', async () => {
      const invalid = await connections().create(
        events([
          { key: 'bad', source: { type: 'tail', config: {} } },
          { key: 'cron', source: { type: 'manual', config: {} } },
          {
            key: 'inline',
            source: { type: 'tail', config: { topic: 't', url: 'https://x.test' } },
          },
        ]),
      );
      expect(invalid._unsafeUnwrapErr()).toMatchObject({
        code: 'invalid_config',
        issues: [
          { path: 'endpoints.0.source.config.topic' },
          { path: 'endpoints.1.source.type' },
          { path: 'endpoints.2.source.config.url' },
        ],
      });
    });

    it('rejects a target endpoint as a trigger and protects used source endpoints', async () => {
      (await connections().create(billing(server.url)))._unsafeUnwrap();
      const created = (await connections().create(events()))._unsafeUnwrap();
      const wrongKind = await jobs().create({
        ...ordersJob,
        trigger: { type: 'tail', connection: { key: 'billing', endpoint: 'charge' }, config: {} },
      });
      expect(wrongKind._unsafeUnwrapErr().issues.map((i) => i.path)).toEqual([
        'trigger.connection.key',
      ]);
      const job = (await jobs().create(ordersJob))._unsafeUnwrap();

      const broken = await connections().update('events', events([]), created.version);
      expect(broken._unsafeUnwrapErr()).toMatchObject({
        issues: [
          {
            path: 'endpoints',
            message:
              'Job "on order" would break: trigger.connection.endpoint: Connection "events" has no endpoint "orders"',
          },
        ],
      });
      expect((await connections().delete('events'))._unsafeUnwrapErr()).toMatchObject({
        code: 'connection_in_use',
        jobIds: [job.id],
      });
      expect((await jobs().resume(job.id)).isOk()).toBe(true);
    });
  });
});

describe('notifier connections', () => {
  const alerts = {
    key: 'alerts',
    notifier: { type: 'webhook', config: { url: '/alerts' } },
  };
  const hooks = (endpoints: unknown[] = [alerts]) => ({
    key: 'hooks',
    type: 'http',
    config: { baseUrl: server.url },
    endpoints,
  });
  const rule = {
    on: ['permanent_failure'],
    notifier: { type: 'webhook', config: {}, connection: { key: 'hooks', endpoint: 'alerts' } },
  };

  it('validates notifier endpoints against the connection', async () => {
    const created = await connections().create(
      hooks([{ key: 'bad', notifier: { type: 'webhook', config: { url: 'https://x.test' } } }]),
    );
    expect(created._unsafeUnwrapErr()).toMatchObject({
      issues: [{ path: 'endpoints.0.notifier.config.url' }],
    });
    const mismatched = await connections().create(
      hooks([{ key: 'mail', notifier: { type: 'email', config: { to: ['a@b.c'] } } }]),
    );
    expect(mismatched._unsafeUnwrapErr()).toMatchObject({
      issues: [{ path: 'endpoints.0.notifier.type' }],
    });
  });

  it('tracks jobs and groups that notify over a connection', async () => {
    const created = (await connections().create(hooks()))._unsafeUnwrap();
    const group = (
      await groups().create({ name: 'ops', defaultNotifications: [rule] })
    )._unsafeUnwrap();
    expect(group.connectionRefs).toEqual([{ key: 'hooks', endpoint: 'alerts' }]);
    const job = (
      await jobs().create({
        name: 'notified',
        trigger: { type: 'manual', config: {} },
        target: { type: 'http', config: { url: `${server.url}/x` } },
        notifications: [rule],
      })
    )._unsafeUnwrap();
    expect(job.connectionRefs).toEqual([{ key: 'hooks', endpoint: 'alerts' }]);

    const usages = await connections().usages('hooks');
    expect(usages.jobs.map((j) => j.id)).toEqual([job.id]);
    expect(usages.groups.map((g) => g.id)).toEqual([group.id]);

    const broken = await connections().update('hooks', hooks([]), created.version);
    expect(broken._unsafeUnwrapErr()).toMatchObject({
      issues: [
        {
          path: 'endpoints',
          message:
            'Job "notified" would break: notifications.0.notifier.connection.endpoint: Connection "hooks" has no endpoint "alerts"',
        },
        {
          path: 'endpoints',
          message:
            'Group "ops" would break: defaultNotifications.0.notifier.connection.endpoint: Connection "hooks" has no endpoint "alerts"',
        },
      ],
    });
    expect(await jobs().delete(job.id)).toBeTruthy();
    expect((await connections().delete('hooks'))._unsafeUnwrapErr()).toMatchObject({
      code: 'connection_in_use',
      message: 'Connection hooks is used by 1 group',
      jobIds: [],
      groupIds: [group.id],
    });
    (
      await groups().update(group.id, { name: 'ops', defaultNotifications: [] }, group.version)
    )._unsafeUnwrap();
    expect((await connections().delete('hooks')).isOk()).toBe(true);
  });

  it('protects a connection while a queued notification still uses it', async () => {
    const created = (await connections().create(hooks()))._unsafeUnwrap();
    const job = (
      await jobs().create({
        name: 'quiet',
        trigger: { type: 'manual', config: {} },
        target: { type: 'http', config: { url: `${server.url}/x` } },
      })
    )._unsafeUnwrap();
    const [delivery] = newDeliveries({
      rules: [NotificationRule.parse(rule)],
      environment: null,
      event: {
        event: 'permanent_failure',
        jobId: job.id,
        jobName: job.name,
        runId: null,
        status: 'failed',
        attempt: 1,
        scheduledAt: null,
        lateReasons: [],
        result: null,
        occurredAt: clock.now(),
      },
      subject: 'run-1',
      now: clock.now(),
    });
    if (!delivery) {
      throw new Error('expected a delivery');
    }
    await db.outbox.enqueue([delivery]);

    expect((await connections().delete('hooks'))._unsafeUnwrapErr()).toMatchObject({
      code: 'connection_in_use',
      message: 'Connection hooks is used by 1 queued notification',
      deliveryIds: [delivery.id],
    });
    const broken = await connections().update('hooks', hooks([]), created.version);
    expect(broken._unsafeUnwrapErr()).toMatchObject({
      issues: [
        {
          path: 'endpoints',
          message: `Queued notification ${delivery.key} would fail: connection.endpoint: Connection "hooks" has no endpoint "alerts"`,
        },
      ],
    });

    const claimed = await db.outbox.claimNext({ workerId: 'd', now: clock.now(), leaseMs: 1_000 });
    if (!claimed) {
      throw new Error('expected a claim');
    }
    await db.outbox.complete(claimed, clock.now());
    expect((await connections().delete('hooks')).isOk()).toBe(true);
  });

  it('refuses a group rule that names a missing connection', async () => {
    const created = await groups().create({ name: 'ops', defaultNotifications: [rule] });
    expect(created._unsafeUnwrapErr()).toMatchObject({
      issues: [
        {
          path: 'defaultNotifications.0.notifier.connection.key',
          message: 'No connection named "hooks"',
        },
      ],
    });
  });
});
