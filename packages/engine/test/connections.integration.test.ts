import {
  type Clock,
  type JobId,
  type Persistence,
  ProviderRegistry,
  mapSecretResolver,
  silentLogger,
} from '@cloud-trigger/core';
import { builtinProviders, createFanoutTarget } from '@cloud-trigger/providers-builtin';
import { type TestHttpServer, startTestHttpServer } from '@cloud-trigger/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ConnectionService, JobService, Worker } from '../src/index.js';
import { type TestDatabase, startTestDatabase } from './databases.js';

let database: TestDatabase;
let db: Persistence;
let server: TestHttpServer;

const clock: Clock = { now: () => new Date('2026-03-01T00:00:00.000Z') };
const registry = new ProviderRegistry().use(builtinProviders);
registry.register(createFanoutTarget(registry));
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
  await database.clear([
    'jobs',
    'job_tags',
    'job_upstreams',
    'job_connections',
    'connections',
    'runs',
  ]);
});

const connections = () => new ConnectionService({ ...db, registry, secrets, clock });
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

    expect((await connections().usages('billing')).map((j) => j.id)).toEqual([job.id]);
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
});
