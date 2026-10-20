import {
  type Clock,
  type JobId,
  type Persistence,
  ProviderRegistry,
  SEALED_PREFIX,
  type SecretCipher,
  type WorkflowRepository,
  err,
  mapSecretResolver,
  ok,
  sealedKeyId,
  silentLogger,
} from '@cloud-trigger/core';
import { builtinProviders, createFanoutTarget } from '@cloud-trigger/providers-builtin';
import { type TestHttpServer, makeWorkflow, startTestHttpServer } from '@cloud-trigger/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ConnectionService,
  GroupService,
  JobService,
  SecretUnavailableError,
  Worker,
  resealSecrets,
  sealedPersistence,
} from '../src/index.js';
import { type TestDatabase, startTestDatabase } from './databases.js';

const TOKEN = 'tok-literal-7f3a';
const HEADER = 'hdr-literal-91bc';
const GROUP_HEADER = 'grp-literal-44de';

const testCipher = (current: string, previous: readonly string[] = []): SecretCipher => {
  const keyring = new Set([current, ...previous]);

  return {
    currentKeyId: current,
    seal: (plaintext) =>
      `${SEALED_PREFIX}${current}:${Buffer.from(plaintext).toString('base64url')}`,
    open: (sealed) => {
      const keyId = sealedKeyId(sealed) ?? '';
      const payload = sealed.slice(`${SEALED_PREFIX}${keyId}:`.length);

      return keyring.has(keyId)
        ? ok(Buffer.from(payload, 'base64url').toString())
        : err({ code: 'secret_key_unknown', message: 'unknown key', keyId });
    },
  };
};

let database: TestDatabase;
let raw: Persistence;
let server: TestHttpServer;

const clock: Clock = { now: () => new Date('2026-03-01T00:00:00.000Z') };
const registry = new ProviderRegistry().use(builtinProviders);
registry.register(createFanoutTarget(registry));
const secrets = mapSecretResolver({});

beforeAll(async () => {
  database = await startTestDatabase('sealed');
  raw = database.persistence;
  server = await startTestHttpServer((req, res) => {
    const authorized =
      req.headers.authorization === `Bearer ${TOKEN}` && req.headers['x-extra'] === HEADER;
    res.writeHead(authorized ? 200 : 401).end('{}');
  });
}, 120_000);

afterAll(async () => {
  await database.stop();
  await server.close();
});

beforeEach(async () => {
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
    'workflows',
  ]);
});

const services = (db: Persistence) => ({
  connections: new ConnectionService({ ...db, registry, secrets, clock }),
  groups: new GroupService({ ...db, registry, clock }),
  jobs: new JobService({ ...db, registry, clock, logger: silentLogger, listeners: [] }),
  worker: new Worker(
    { ...db, registry, secrets, clock, logger: silentLogger, listeners: [] },
    {
      workerId: 'w1',
      concurrency: 2,
      pollIntervalMs: 50,
      leaseMs: 30_000,
      bufferedRequeueDelayMs: 1_000,
    },
  ),
});

const billing = () => ({
  key: 'billing',
  type: 'http',
  config: { baseUrl: `${server.url}/v1`, auth: { type: 'bearer', token: TOKEN } },
  endpoints: [{ key: 'charge', target: { type: 'http', config: { method: 'POST', url: '/c' } } }],
});

const chargeJob = {
  name: 'charge',
  trigger: { type: 'manual', config: {} },
  target: {
    type: 'http',
    connection: { key: 'billing', endpoint: 'charge' },
    config: { secretHeaders: { 'x-extra': HEADER } },
  },
};

const notifyGroup = () => ({
  name: 'ops',
  defaultNotifications: [
    {
      on: ['failure'],
      notifier: {
        type: 'webhook',
        config: { url: `${server.url}/hook`, secretHeaders: { 'x-group': GROUP_HEADER } },
      },
    },
  ],
});

const runOnce = async (db: Persistence, jobId: JobId) => {
  const { jobs, worker } = services(db);
  await jobs.runNow(jobId);
  await worker.tick();
  await worker.stop();

  return (await db.runs.list({ jobId, limit: 10 })).items[0];
};

const rawDump = async () =>
  JSON.stringify([
    await raw.connections.list({ limit: 100 }),
    await raw.jobs.list({ limit: 100 }),
    await raw.groups.list({ limit: 100 }),
  ]);

describe('sealed persistence', () => {
  it('stores secrets encrypted and hands plaintext to the engine', async () => {
    const sealed = sealedPersistence(raw, { registry, cipher: testCipher('k1') });
    const { connections, groups, jobs } = services(sealed);
    (await connections.create(billing()))._unsafeUnwrap();
    (await groups.create(notifyGroup()))._unsafeUnwrap();
    const job = (await jobs.create(chargeJob))._unsafeUnwrap();

    const dump = await rawDump();
    expect(dump).not.toContain(TOKEN);
    expect(dump).not.toContain(HEADER);
    expect(dump).not.toContain(GROUP_HEADER);
    expect(dump).toContain(`${SEALED_PREFIX}k1:`);
    expect((await sealed.connections.get('billing'))?.config).toMatchObject({
      auth: { token: TOKEN },
    });
    expect((await sealed.jobs.get(job.id))?.target.config).toEqual({
      secretHeaders: { 'x-extra': HEADER },
    });

    const run = await runOnce(sealed, job.id);
    expect(run?.status).toBe('succeeded');
  });

  it('reads legacy plaintext and reseals it', async () => {
    const { connections, groups, jobs } = services(raw);
    (await connections.create(billing()))._unsafeUnwrap();
    (await groups.create(notifyGroup()))._unsafeUnwrap();
    const job = (await jobs.create(chargeJob))._unsafeUnwrap();
    expect(await rawDump()).toContain(TOKEN);

    const deps = { registry, cipher: testCipher('k1') };
    const sealed = sealedPersistence(raw, deps);
    expect((await sealed.jobs.get(job.id))?.target.config).toEqual({
      secretHeaders: { 'x-extra': HEADER },
    });

    const report = await resealSecrets(raw, deps);
    expect(report).toMatchObject({
      connections: { resealed: 1, skipped: 0 },
      jobs: { resealed: 1, skipped: 0 },
      groups: { resealed: 1, skipped: 0 },
    });
    expect(await rawDump()).not.toContain(TOKEN);
    expect((await resealSecrets(raw, deps)).connections).toMatchObject({ resealed: 0 });
    expect((await runOnce(sealed, job.id))?.status).toBe('succeeded');
  });

  it('keeps a schedule the monitor advances while resealing a workflow', async () => {
    const first = new Date('2026-03-01T00:00:00.000Z');
    const second = new Date('2026-03-01T00:01:00.000Z');
    const workflow = makeWorkflow(
      {
        nodes: [
          {
            key: 'call',
            kind: 'inline',
            job: {
              target: {
                type: 'http',
                config: { url: `${server.url}/w`, secretHeaders: { 'x-extra': HEADER } },
              },
            },
          },
        ],
        edges: [],
      },
      first,
    );
    await raw.workflows.insert(workflow);

    const inner = raw.workflows;
    const racing: WorkflowRepository = {
      insert: (w) => inner.insert(w),
      get: (id) => inner.get(id),
      list: async (query) => {
        const page = await inner.list(query);
        await inner.advanceSchedule(workflow.id, { from: first, to: second });

        return page;
      },
      update: (id, change, expectedVersion) => inner.update(id, change, expectedVersion),
      delete: (id) => inner.delete(id),
      findByEnvironment: (environment) => inner.findByEnvironment(environment),
      findDue: (p) => inner.findDue(p),
      advanceSchedule: (id, p) => inner.advanceSchedule(id, p),
    };

    const report = await resealSecrets(
      { ...raw, workflows: racing },
      {
        registry,
        cipher: testCipher('k1'),
      },
    );
    expect(report.workflows).toMatchObject({ resealed: 1, skipped: 0 });
    const stored = await raw.workflows.get(workflow.id);
    expect(stored?.nextFireAt).toEqual(second);
    expect(JSON.stringify(stored)).not.toContain(HEADER);
  });

  it('rotates to a new key and fails closed on an unknown one', async () => {
    const before = sealedPersistence(raw, { registry, cipher: testCipher('k1') });
    (await services(before).connections.create(billing()))._unsafeUnwrap();

    const rotated = { registry, cipher: testCipher('k2', ['k1']) };
    expect(
      (await sealedPersistence(raw, rotated).connections.get('billing'))?.config,
    ).toMatchObject({ auth: { token: TOKEN } });
    expect((await resealSecrets(raw, rotated)).connections).toMatchObject({ resealed: 1 });
    expect(await rawDump()).toContain(`${SEALED_PREFIX}k2:`);
    expect(await rawDump()).not.toContain(`${SEALED_PREFIX}k1:`);

    const unknown = sealedPersistence(raw, { registry, cipher: testCipher('k3') });
    await expect(unknown.connections.get('billing')).rejects.toBeInstanceOf(SecretUnavailableError);
  });
});
