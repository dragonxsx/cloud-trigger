import {
  type Clock,
  type JobId,
  type Persistence,
  ProviderRegistry,
  SEALED_PREFIX,
  type SecretCipher,
  mapSecretResolver,
  ok,
  silentLogger,
} from '@cloud-trigger/core';
import { builtinProviders, createFanoutTarget } from '@cloud-trigger/providers-builtin';
import { type TestHttpServer, startTestHttpServer } from '@cloud-trigger/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ConnectionExtractor,
  ConnectionService,
  JobService,
  Worker,
  sealedPersistence,
} from '../src/index.js';
import { type TestDatabase, startTestDatabase } from './databases.js';

const TOKEN = 'tok-literal-5be1';

const cipher: SecretCipher = {
  currentKeyId: 'k1',
  seal: (plaintext) => `${SEALED_PREFIX}k1:${Buffer.from(plaintext).toString('base64url')}`,
  open: (sealed) =>
    ok(Buffer.from(sealed.slice(`${SEALED_PREFIX}k1:`.length), 'base64url').toString()),
};

let database: TestDatabase;
let raw: Persistence;
let db: Persistence;
let server: TestHttpServer;

const clock: Clock = { now: () => new Date('2026-03-01T00:00:00.000Z') };
const registry = new ProviderRegistry().use(builtinProviders);
registry.register(createFanoutTarget(registry));
const secrets = mapSecretResolver({});

beforeAll(async () => {
  database = await startTestDatabase('extract');
  raw = database.persistence;
  db = sealedPersistence(raw, { registry, cipher });
  server = await startTestHttpServer((req, res) => {
    res.writeHead(req.headers.authorization === `Bearer ${TOKEN}` ? 200 : 401).end('{}');
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

const connections = () => new ConnectionService({ ...db, registry, secrets, clock });
const jobs = () => new JobService({ ...db, registry, clock, logger: silentLogger, listeners: [] });
const extractor = () =>
  new ConnectionExtractor({
    ...db,
    registry,
    clock,
    jobService: jobs(),
    connectionService: connections(),
  });

const inlineJob = () => ({
  name: 'Nightly charge',
  trigger: { type: 'manual', config: {} },
  target: {
    type: 'http',
    config: {
      method: 'POST',
      url: `${server.url}/v1/charges?dry=1`,
      secretHeaders: { authorization: `Bearer ${TOKEN}` },
    },
  },
});

const runOnce = async (jobId: JobId) => {
  await jobs().runNow(jobId);
  const worker = new Worker(
    { ...db, registry, secrets, clock, logger: silentLogger, listeners: [] },
    {
      workerId: 'w1',
      concurrency: 1,
      pollIntervalMs: 50,
      leaseMs: 30_000,
      bufferedRequeueDelayMs: 1_000,
    },
  );
  await worker.tick();
  await worker.stop();

  const request = server.requests.at(-1);

  return {
    method: request?.method,
    url: request?.url,
    body: request?.body,
    authorization: request?.headers.authorization,
  };
};

const target = { kind: 'target' } as const;

describe('extracting a connection from a job', () => {
  it('previews without writing anything', async () => {
    const job = (await jobs().create(inlineJob()))._unsafeUnwrap();
    const preview = (
      await extractor().extract({ id: job.id, slot: target, expectedVersion: 1, dryRun: true })
    )._unsafeUnwrap();

    expect(preview.connection).toMatchObject({ key: '127-0-0-1', type: 'http' });
    expect(preview.job.connectionRefs).toEqual([{ key: '127-0-0-1', endpoint: 'nightly-charge' }]);
    expect((await db.connections.list({ limit: 10 })).items).toEqual([]);
    expect((await db.jobs.get(job.id))?.version).toBe(1);
  });

  it('creates the connection, rewires the job and keeps sending the same request', async () => {
    const job = (await jobs().create(inlineJob()))._unsafeUnwrap();
    const before = await runOnce(job.id);

    const result = (
      await extractor().extract({
        id: job.id,
        slot: target,
        key: 'billing',
        expectedVersion: 1,
        dryRun: false,
      })
    )._unsafeUnwrap();

    expect(result.job.target).toEqual({
      type: 'http',
      connection: { key: 'billing', endpoint: 'nightly-charge' },
      config: {},
    });
    expect(result.job.version).toBe(2);
    expect((await connections().usages('billing')).jobs.map((j) => j.id)).toEqual([job.id]);

    const after = await runOnce(job.id);
    expect(after).toEqual(before);
    expect(after).toMatchObject({ url: '/v1/charges?dry=1', authorization: `Bearer ${TOKEN}` });
  });

  it('stores the moved secrets sealed on the connection only', async () => {
    const job = (await jobs().create(inlineJob()))._unsafeUnwrap();
    (
      await extractor().extract({
        id: job.id,
        slot: target,
        key: 'billing',
        expectedVersion: 1,
        dryRun: false,
      })
    )._unsafeUnwrap();

    const stored = await raw.connections.get('billing');
    expect(JSON.stringify(stored?.config)).toContain(SEALED_PREFIX);
    expect(JSON.stringify(stored)).not.toContain(TOKEN);
    expect(JSON.stringify(await raw.jobs.get(job.id))).not.toContain('authorization');
  });

  it('suffixes a taken default key and flags the identical connection', async () => {
    const job = (await jobs().create(inlineJob()))._unsafeUnwrap();
    (
      await connections().create({
        key: '127-0-0-1',
        type: 'http',
        config: { baseUrl: server.url, secretHeaders: { authorization: 'other' } },
      })
    )._unsafeUnwrap();

    const preview = (
      await extractor().extract({ id: job.id, slot: target, expectedVersion: 1, dryRun: true })
    )._unsafeUnwrap();

    expect(preview.connection.key).toBe('127-0-0-1-2');
    expect(preview.similar).toEqual([{ key: '127-0-0-1', name: '', match: 'identical' }]);
  });

  it('leaves nothing behind when the job changed meanwhile', async () => {
    const job = (await jobs().create(inlineJob()))._unsafeUnwrap();
    const stale = await extractor().extract({
      id: job.id,
      slot: target,
      expectedVersion: 2,
      dryRun: false,
    });

    expect(stale._unsafeUnwrapErr().code).toBe('version_conflict');
    expect((await db.connections.list({ limit: 10 })).items).toEqual([]);
  });

  it('refuses a key that is already taken', async () => {
    const job = (await jobs().create(inlineJob()))._unsafeUnwrap();
    (
      await connections().create({ key: 'billing', type: 'http', config: { baseUrl: server.url } })
    )._unsafeUnwrap();
    const taken = await extractor().extract({
      id: job.id,
      slot: target,
      key: 'billing',
      expectedVersion: 1,
      dryRun: true,
    });

    expect(taken._unsafeUnwrapErr()).toMatchObject({ issues: [{ path: 'key' }] });
  });

  it('deletes the new connection when the job update throws', async () => {
    const job = (await jobs().create(inlineJob()))._unsafeUnwrap();
    class FailingJobService extends JobService {
      override update(): never {
        throw new Error('database unavailable');
      }
    }
    const failing = new ConnectionExtractor({
      ...db,
      registry,
      clock,
      jobService: new FailingJobService({
        ...db,
        registry,
        clock,
        logger: silentLogger,
        listeners: [],
      }),
      connectionService: connections(),
    });

    await expect(
      failing.extract({
        id: job.id,
        slot: target,
        key: 'billing',
        expectedVersion: 1,
        dryRun: false,
      }),
    ).rejects.toThrow('database unavailable');
    expect((await db.connections.list({ limit: 10 })).items).toEqual([]);
  });

  it('keeps probing default keys past the first batch', async () => {
    const job = (await jobs().create(inlineJob()))._unsafeUnwrap();
    const taken = ['127-0-0-1', ...Array.from({ length: 20 }, (_, i) => `127-0-0-1-${i + 2}`)];
    for (const key of taken) {
      (
        await connections().create({ key, type: 'http', config: { baseUrl: 'https://other' } })
      )._unsafeUnwrap();
    }

    const preview = (
      await extractor().extract({ id: job.id, slot: target, expectedVersion: 1, dryRun: true })
    )._unsafeUnwrap();
    expect(preview.connection.key).toBe('127-0-0-1-22');

    const saved = (
      await extractor().extract({ id: job.id, slot: target, expectedVersion: 1, dryRun: false })
    )._unsafeUnwrap();
    expect(saved.connection.key).toBe('127-0-0-1-22');
  });
});
