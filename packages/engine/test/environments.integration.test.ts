import { setTimeout as sleep } from 'node:timers/promises';

import {
  type Clock,
  type JobId,
  type Persistence,
  ProviderRegistry,
  defineConnection,
  defineInlineConnectedEventSource,
  mapSecretResolver,
  silentLogger,
} from '@cloud-trigger/core';
import { builtinProviders } from '@cloud-trigger/providers-builtin';
import { type TestHttpServer, startTestHttpServer } from '@cloud-trigger/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ConnectionService,
  ConsumerSupervisor,
  EnvironmentService,
  EventIngestor,
  GroupService,
  JobService,
  NotificationEnqueuer,
  Worker,
} from '../src/index.js';
import { type TestDatabase, startTestDatabase } from './databases.js';

let database: TestDatabase;
let db: Persistence;
let server: TestHttpServer;

const clock: Clock = { now: () => new Date('2026-03-01T00:00:00.000Z') };
const registry = new ProviderRegistry().use(builtinProviders);
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
  configSchema: z.object({ ...broker.configSchema.partial().shape, topic: z.string().min(1) }),
  exclusive: false,
  describe: (config) => `On ${config.topic}`,
  async subscribe(config, { signal, connection }) {
    subscriptions.push(`${connection.config.url}/${config.topic}`);
    await sleep(60_000, undefined, { signal }).catch(() => undefined);
  },
});
registry.register(broker, tail);
const secrets = mapSecretResolver({});

beforeAll(async () => {
  database = await startTestDatabase('environments');
  db = database.persistence;
  server = await startTestHttpServer((_req, res) => {
    res.writeHead(200).end('{}');
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
    'connection_environments',
    'environments',
    'runs',
    'notifications_outbox',
  ]);
  for (const key of ['staging', 'prod']) {
    (await environments().create({ key }))._unsafeUnwrap();
  }
});

const environments = () => new EnvironmentService({ ...db, clock });
const connections = () => new ConnectionService({ ...db, registry, secrets, clock });
const groups = () => new GroupService({ ...db, registry, clock });
const jobs = () => new JobService({ ...db, registry, clock, logger: silentLogger, listeners: [] });

const runOnce = async (jobId: JobId) => {
  await jobs().runNow(jobId);
  const worker = new Worker(
    { ...db, registry, secrets, clock, logger: silentLogger, listeners: [] },
    {
      workerId: 'w1',
      concurrency: 2,
      pollIntervalMs: 50,
      leaseMs: 30_000,
      bufferedRequeueDelayMs: 1_000,
    },
  );
  await worker.tick();
  await worker.stop();

  return server.requests.at(-1)?.url;
};

const billing = () => ({
  key: 'billing',
  type: 'http',
  config: { baseUrl: `${server.url}/live` },
  endpoints: [
    { key: 'charge', target: { type: 'http', config: { method: 'POST', url: '/charges' } } },
  ],
  overlays: [
    {
      environment: 'staging',
      config: { baseUrl: `${server.url}/staging` },
      endpoints: [{ key: 'charge', config: { url: '/test-charges' } }],
    },
  ],
});

const chargeJob = (extra: Record<string, unknown> = {}) => ({
  name: 'charge',
  trigger: { type: 'manual', config: {} },
  target: { type: 'http', connection: { key: 'billing', endpoint: 'charge' }, config: {} },
  ...extra,
});

const withOverlay = (overlay: Record<string, unknown>) =>
  connections().create({ ...billing(), overlays: [overlay] });

describe('environment overlays', () => {
  it('runs a job against the overlay of its environment and the base config otherwise', async () => {
    (await connections().create(billing()))._unsafeUnwrap();
    const base = (await jobs().create(chargeJob()))._unsafeUnwrap();
    const staged = (
      await jobs().create(chargeJob({ name: 'staged', environment: 'staging' }))
    )._unsafeUnwrap();
    const prod = (
      await jobs().create(chargeJob({ name: 'prod', environment: 'prod' }))
    )._unsafeUnwrap();

    expect(await runOnce(base.id)).toBe('/live/charges');
    expect(await runOnce(staged.id)).toBe('/staging/test-charges');
    expect(await runOnce(prod.id)).toBe('/live/charges');
  });

  it('inherits the group environment unless the job sets its own', async () => {
    (await connections().create(billing()))._unsafeUnwrap();
    const group = (await groups().create({ name: 'qa', environment: 'staging' }))._unsafeUnwrap();
    const member = (await jobs().create(chargeJob({ groupId: group.id })))._unsafeUnwrap();
    const own = (
      await jobs().create(chargeJob({ name: 'own', groupId: group.id, environment: 'prod' }))
    )._unsafeUnwrap();

    expect(await runOnce(member.id)).toBe('/staging/test-charges');
    expect(await runOnce(own.id)).toBe('/live/charges');
  });

  it('rejects unknown environments, unknown endpoints and invalid overlays', async () => {
    expect(
      (await jobs().create(chargeJob({ environment: 'qa' })))._unsafeUnwrapErr(),
    ).toMatchObject({ issues: [{ path: 'environment', message: 'No environment named "qa"' }] });
    expect(
      (await groups().create({ name: 'qa', environment: 'qa' }))._unsafeUnwrapErr(),
    ).toMatchObject({ issues: [{ path: 'environment' }] });

    expect((await withOverlay({ environment: 'qa' }))._unsafeUnwrapErr()).toMatchObject({
      issues: [{ path: 'overlays.0.environment' }],
    });
    expect(
      (
        await withOverlay({ environment: 'staging', endpoints: [{ key: 'nope', config: {} }] })
      )._unsafeUnwrapErr(),
    ).toMatchObject({ issues: [{ path: 'overlays.0.endpoints.0.key' }] });
    expect(
      (
        await withOverlay({ environment: 'staging', config: { baseUrl: 'not a url' } })
      )._unsafeUnwrapErr(),
    ).toMatchObject({ issues: [{ path: 'overlays.0.config.baseUrl' }] });
    expect(
      (
        await withOverlay({
          environment: 'staging',
          endpoints: [{ key: 'charge', config: { url: 'https://evil.test' } }],
        })
      )._unsafeUnwrapErr(),
    ).toMatchObject({ issues: [{ path: 'overlays.0.endpoints.0.config.url' }] });
  });

  it('tests a connection with an overlay applied', async () => {
    const tested = await connections().test({
      type: 'http',
      config: { baseUrl: `${server.url}/live` },
      overlay: { baseUrl: 'not a url' },
    });
    expect(tested._unsafeUnwrapErr()).toMatchObject({ issues: [{ path: 'config.baseUrl' }] });
  });

  it('checks inherited group notifications in a member job environment', async () => {
    (
      await connections().create({
        key: 'hooks',
        type: 'http',
        config: { baseUrl: `${server.url}/hooks` },
        endpoints: [
          {
            key: 'signed',
            notifier: {
              type: 'webhook',
              config: { url: '/runs', signing: { secret: 'shh' } },
            },
          },
        ],
        overlays: [
          { environment: 'staging', endpoints: [{ key: 'signed', config: { signing: null } }] },
        ],
      })
    )._unsafeUnwrap();
    const rule = {
      on: ['permanent_failure'],
      notifier: {
        type: 'webhook',
        connection: { key: 'hooks', endpoint: 'signed' },
        config: { signing: { header: 'X-Sig' } },
      },
    };
    const group = (
      await groups().create({ name: 'ops', defaultNotifications: [rule] })
    )._unsafeUnwrap();
    const member = (q: Record<string, unknown>) =>
      jobs().create({
        name: 'staged',
        groupId: group.id,
        trigger: { type: 'manual', config: {} },
        target: { type: 'http', config: { url: `${server.url}/x` } },
        ...q,
      });

    expect((await member({ environment: 'staging' }))._unsafeUnwrapErr()).toMatchObject({
      issues: [{ path: 'groupId' }],
    });
    (await member({ environment: 'prod' }))._unsafeUnwrap();

    (
      await groups().update(group.id, { name: 'ops', defaultNotifications: [] }, group.version)
    )._unsafeUnwrap();
    (await member({ environment: 'staging' }))._unsafeUnwrap();
    expect(
      (
        await groups().update(group.id, { name: 'ops', defaultNotifications: [rule] }, 2)
      )._unsafeUnwrapErr(),
    ).toMatchObject({
      issues: [{ path: 'defaultNotifications.0.notifier.config.signing.secret' }],
    });
  });

  it('pins the environment on queued notifications', async () => {
    const group = (await groups().create({ name: 'qa', environment: 'staging' }))._unsafeUnwrap();
    const job = (
      await jobs().create({
        name: 'notified',
        groupId: group.id,
        trigger: { type: 'manual', config: {} },
        target: { type: 'http', config: { url: `${server.url}/x` } },
        notifications: [
          { on: ['late'], notifier: { type: 'webhook', config: { url: `${server.url}/hook` } } },
        ],
      })
    )._unsafeUnwrap();
    await new NotificationEnqueuer({ ...db, clock }).forJob(job, 'late', {
      subject: 'late:1',
      status: 'late',
      lateReasons: [],
    });
    const delivery = await db.outbox.claimNext({
      workerId: 'd1',
      now: clock.now(),
      leaseMs: 1_000,
    });
    expect(delivery?.environment).toBe('staging');
  });

  it('resubscribes an event source when its group moves to another environment', async () => {
    (
      await connections().create({
        key: 'events',
        type: 'broker',
        config: { url: 'https://broker.test' },
        overlays: [{ environment: 'staging', config: { url: 'https://staging.broker.test' } }],
      })
    )._unsafeUnwrap();
    const group = (await groups().create({ name: 'consumers' }))._unsafeUnwrap();
    (
      await jobs().create({
        name: 'orders',
        groupId: group.id,
        trigger: { type: 'tail', connection: { key: 'events' }, config: { topic: 'orders' } },
        target: { type: 'http', config: { url: `${server.url}/orders` } },
      })
    )._unsafeUnwrap();
    let now = clock.now();
    const consumer = new ConsumerSupervisor(
      {
        ...db,
        registry,
        secrets,
        clock: { now: () => now },
        logger: silentLogger,
        ingestor: new EventIngestor({ ...db, registry, secrets, clock, logger: silentLogger }),
      },
      { ownerId: 'c1', intervalMs: 50, leaseMs: 1_000, restartDelayMs: 20 },
    );
    try {
      await consumer.tick();
      expect(subscriptions).toEqual(['https://broker.test/orders']);
      (
        await groups().update(group.id, { name: 'consumers', environment: 'staging' }, 1)
      )._unsafeUnwrap();
      now = new Date(now.getTime() + 60_000);
      await consumer.tick();
      expect(subscriptions).toEqual([
        'https://broker.test/orders',
        'https://staging.broker.test/orders',
      ]);
    } finally {
      await consumer.stop();
    }
  });

  it('refuses to delete an environment while anything uses it', async () => {
    (await connections().create(billing()))._unsafeUnwrap();
    const job = (await jobs().create(chargeJob({ environment: 'prod' })))._unsafeUnwrap();
    expect((await environments().delete('staging'))._unsafeUnwrapErr()).toMatchObject({
      code: 'environment_in_use',
      message: 'Environment staging is used by 1 connection overlay',
      connectionKeys: ['billing'],
    });
    expect((await environments().delete('prod'))._unsafeUnwrapErr()).toMatchObject({
      code: 'environment_in_use',
      jobIds: [job.id],
    });
    expect(await jobs().delete(job.id)).toBeTruthy();
    expect((await environments().delete('prod')).isOk()).toBe(true);
    expect((await environments().delete('prod'))._unsafeUnwrapErr().code).toBe('not_found');
  });
});
