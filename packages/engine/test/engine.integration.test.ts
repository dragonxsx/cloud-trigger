import { createServer, type Server } from 'node:http';

import {
  type Clock,
  type Job,
  type JobId,
  ProviderRegistry,
  type RunRepository,
  type RunningRun,
  mapSecretResolver,
  silentLogger,
} from '@cloud-trigger/core';
import { type MongoPersistence, createMongoPersistence } from '@cloud-trigger/persistence-mongo';
import { builtinProviders } from '@cloud-trigger/providers-builtin';
import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  AnalyticsListener,
  JobService,
  Reaper,
  type RunLifecycleListener,
  Scheduler,
  Worker,
  type WorkerDeps,
  type WorkerOptions,
} from '../src/index.js';

let container: StartedMongoDBContainer;
let db: MongoPersistence;
let admin: MongoClient;
let server: Server;
let base = '';
let hits = 0;
let gate: Promise<void> = Promise.resolve();

let current = new Date('2026-03-01T00:00:00.000Z');
const clock: Clock = { now: () => new Date(current) };
const advance = (ms: number) => {
  current = new Date(current.getTime() + ms);
};

const registry = new ProviderRegistry().use(builtinProviders);
const secrets = mapSecretResolver({});

beforeAll(async () => {
  container = await new MongoDBContainer('mongo:8').start();
  const uri = `${container.getConnectionString()}?directConnection=true`;
  db = await createMongoPersistence({ uri, dbName: 'engine' });
  await db.migrate();
  admin = await MongoClient.connect(uri);
  server = createServer((req, res) => {
    hits++;
    const path = req.url ?? '/';
    if (path.startsWith('/slow')) {
      setTimeout(() => res.end('slow'), 1_500);
    } else if (path.startsWith('/gate')) {
      void gate.then(() => res.end('{"ok":true}'));
    } else if (path.startsWith('/fail')) {
      res.writeHead(503).end();
    } else {
      res.end('{"ok":true}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('tcp');
  }
  base = `http://127.0.0.1:${address.port}`;
}, 120_000);

afterAll(async () => {
  await db.close();
  await admin.close();
  await container.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  hits = 0;
  await Promise.all(
    ['jobs', 'runs', 'run_metrics'].map((c) => admin.db('engine').collection(c).deleteMany({})),
  );
});

const listeners = (): RunLifecycleListener[] => [new AnalyticsListener(db.analytics)];
const service = (extra: readonly RunLifecycleListener[] = []) =>
  new JobService({
    ...db,
    registry,
    clock,
    logger: silentLogger,
    listeners: [...listeners(), ...extra],
  });
const scheduler = (ownerId = 's1') =>
  new Scheduler(
    { ...db, registry, clock, logger: silentLogger },
    { ownerId, intervalMs: 1_000, claimLeaseMs: 30_000, batchSize: 50 },
  );
const reaper = () =>
  new Reaper(
    { ...db, clock, logger: silentLogger, listeners: listeners() },
    { intervalMs: 1_000, batchSize: 10 },
  );
const worker = (opts: Partial<WorkerOptions> = {}, deps: Partial<WorkerDeps> = {}) =>
  new Worker(
    {
      ...db,
      registry,
      secrets,
      clock,
      logger: silentLogger,
      listeners: listeners(),
      ...deps,
    },
    {
      workerId: 'w1',
      concurrency: 4,
      pollIntervalMs: 50,
      leaseMs: 30_000,
      bufferedRequeueDelayMs: 1_000,
      ...opts,
    },
  );
const claimOnceAndSettle = async (w: Worker) => {
  await w.tick();
  await w.stop();
};

const createJob = async (path: string, extra: Record<string, unknown> = {}): Promise<Job> =>
  (
    await service().create({
      name: `job ${path}`,
      trigger: { type: 'interval', config: { every: 1, unit: 'minutes' } },
      target: { type: 'http', config: { method: 'GET', url: `${base}${path}` } },
      ...extra,
    })
  )._unsafeUnwrap();

const runsOf = async (jobId: JobId) => (await db.runs.list({ jobId, limit: 100 })).items;

describe('engine', () => {
  it('schedules, executes and records analytics', async () => {
    const job = await createJob('/ok');
    expect(job.schedule.nextFireAt).not.toBeNull();
    current = job.schedule.nextFireAt ?? current;
    await scheduler().tick();
    await claimOnceAndSettle(worker());

    const [run] = await runsOf(job.id);
    expect(run?.status).toBe('succeeded');
    expect(hits).toBe(1);
    const stored = await db.jobs.get(job.id);
    expect(stored?.schedule.fireCount).toBe(1);
    expect(stored?.schedule.lastSuccessAt).not.toBeNull();
    const summary = await db.analytics.summary({
      from: new Date(0),
      to: new Date(current.getTime() + 60_000),
      jobId: job.id,
    });
    expect(summary.byStatus).toEqual({ succeeded: 1 });
  });

  it('fires exactly once across competing schedulers', async () => {
    const job = await createJob('/ok');
    current = job.schedule.nextFireAt ?? current;
    await Promise.all([scheduler('a').tick(), scheduler('b').tick(), scheduler('c').tick()]);
    expect(await runsOf(job.id)).toHaveLength(1);
  });

  it('retries with backoff then fails, auto-pausing after consecutive failures', async () => {
    const job = await createJob('/fail', {
      policy: { retry: { maxAttempts: 2, delayMs: 5_000 }, pauseAfterConsecutiveFailures: 1 },
    });
    await service().runNow(job.id);
    await claimOnceAndSettle(worker());
    let [run] = await runsOf(job.id);
    expect(run?.status).toBe('pending');
    advance(5_000);
    await claimOnceAndSettle(worker());
    [run] = await runsOf(job.id);
    expect(run?.status).toBe('failed');
    expect(run?.attempts).toHaveLength(2);
    expect((await db.jobs.get(job.id))?.pausedReason).toMatch(/Auto-paused/);
  });

  it('forbid overlap skips the newer run', async () => {
    const job = await createJob('/slow', { policy: { overlap: 'forbid' } });
    await service().runNow(job.id);
    const w = worker();
    void w.tick();
    await new Promise((r) => setTimeout(r, 200));
    await service().runNow(job.id);
    await w.tick();
    await w.stop();
    const statuses = (await runsOf(job.id)).map((r) => r.status).toSorted();
    expect(statuses).toEqual(['skipped', 'succeeded']);
  });

  it('replace overlap cancels the older run', async () => {
    const job = await createJob('/slow', { policy: { overlap: 'replace' } });
    await service().runNow(job.id);
    const w = worker({ leaseMs: 900 });
    void w.tick();
    await new Promise((r) => setTimeout(r, 200));
    await service().runNow(job.id);
    await w.tick();
    await w.stop();
    const statuses = (await runsOf(job.id)).map((r) => r.status).toSorted();
    expect(statuses).toEqual(['cancelled', 'succeeded']);
  }, 10_000);

  it('times out runs and reaps expired leases', async () => {
    const slow = await createJob('/slow', { policy: { timeoutMs: 200 } });
    await service().runNow(slow.id);
    await claimOnceAndSettle(worker());
    expect((await runsOf(slow.id))[0]?.status).toBe('timed_out');

    const job = await createJob('/ok', { policy: { retry: { maxAttempts: 3, delayMs: 0 } } });
    await service().runNow(job.id);
    const claimed: RunningRun | undefined = await db.queue.claimNext({
      workerId: 'dead',
      now: clock.now(),
      leaseMs: 1_000,
    });
    expect(claimed?.jobId).toBe(job.id);
    advance(2_000);
    await reaper().tick();
    const [recovered] = await runsOf(job.id);
    expect(recovered?.status).toBe('pending');
    expect(recovered?.attempts[0]?.result.error?.code).toBe('lease_lost');
    await claimOnceAndSettle(worker());
    expect((await runsOf(job.id))[0]?.status).toBe('succeeded');
  });

  it('applies terminal bookkeeping to runs the reaper fails', async () => {
    const job = await createJob('/ok', { policy: { pauseAfterConsecutiveFailures: 1 } });
    await service().runNow(job.id);
    await db.queue.claimNext({ workerId: 'dead', now: clock.now(), leaseMs: 1_000 });
    advance(2_000);
    await reaper().tick();

    expect((await runsOf(job.id))[0]?.status).toBe('failed');
    const stored = await db.jobs.get(job.id);
    expect(stored?.schedule.consecutiveFailures).toBe(1);
    expect(stored?.pausedReason).toMatch(/Auto-paused/);
    const summary = await db.analytics.summary({
      from: new Date(0),
      to: new Date(current.getTime() + 60_000),
      jobId: job.id,
    });
    expect(summary.byStatus).toEqual({ failed: 1 });
  });

  it('completes a run whose target finishes while a lease renewal is in flight', async () => {
    const renewed = Promise.withResolvers<void>();
    gate = renewed.promise;
    const job = await createJob('/gate');
    await service().runNow(job.id);
    const w = worker(
      { leaseMs: 750 },
      {
        queue: {
          // Advance time after the claim so the renewal really moves `lease.until`.
          claimNext: async (p) => {
            const claimed = await db.queue.claimNext(p);
            advance(1_000);

            return claimed;
          },
          requestCancel: (id) => db.queue.requestCancel(id),
          findExpired: (p) => db.queue.findExpired(p),
          acquireExecution: (run) => db.queue.acquireExecution(run),
          buffer: (previous, next) => db.queue.buffer(previous, next),
          renewLease: async (p) => {
            const result = await db.queue.renewLease(p);
            renewed.resolve();
            await new Promise((r) => setTimeout(r, 300));

            return result;
          },
        },
      },
    );
    await claimOnceAndSettle(w);
    expect((await runsOf(job.id))[0]?.status).toBe('succeeded');
  });

  it('counts concurrent failures without losing any', async () => {
    const job = await createJob('/fail', {
      policy: { overlap: 'allow', pauseAfterConsecutiveFailures: 2 },
    });
    await Promise.all([service().runNow(job.id), service().runNow(job.id)]);
    await claimOnceAndSettle(worker());
    const stored = await db.jobs.get(job.id);
    expect(stored?.schedule.consecutiveFailures).toBe(2);
    expect(stored?.pausedReason).toMatch(/Auto-paused after 2/);
  });

  it('buffers only one run when several are claimed concurrently', async () => {
    const job = await createJob('/slow', { policy: { overlap: 'buffer_one' } });
    await service().runNow(job.id);
    const executor = worker();
    void executor.tick();
    await new Promise((r) => setTimeout(r, 200));

    const bothChecking = Promise.withResolvers<void>();
    let checks = 0;
    const runs: RunRepository = {
      insert: (run) => db.runs.insert(run),
      get: (id) => db.runs.get(id),
      list: (query) => db.runs.list(query),
      transition: (previous, next) => db.runs.transition(previous, next),
      countByStatus: (id, statuses) => db.runs.countByStatus(id, statuses),
      prune: (id, keep) => db.runs.prune(id, keep),
      findByStatus: async (id, statuses) => {
        if (++checks === 2) {
          bothChecking.resolve();
        }
        await bothChecking.promise;

        return db.runs.findByStatus(id, statuses);
      },
    };
    await Promise.all([service().runNow(job.id), service().runNow(job.id)]);
    const [a, b] = ['w2', 'w3'].map((workerId) => worker({ workerId, concurrency: 1 }, { runs }));
    await Promise.all([a?.tick(), b?.tick()]);
    await Promise.all([a?.stop(), b?.stop(), executor.stop()]);
    const statuses = (await runsOf(job.id)).map((r) => r.status).toSorted();
    expect(statuses).toEqual(['pending', 'skipped', 'succeeded']);
  });

  it('does not re-arm an exhausted schedule when the job is edited', async () => {
    const spec = {
      name: 'capped',
      trigger: { type: 'interval', config: { every: 1, unit: 'minutes', maxCount: 2 } },
      target: { type: 'http', config: { method: 'GET', url: `${base}/ok` } },
    };
    const job = (await service().create(spec))._unsafeUnwrap();
    await db.jobs.patchSchedule(job.id, { fireCount: 2, nextFireAt: null });
    const edited = await service().update(
      job.id,
      { ...spec, trigger: { ...spec.trigger, jitterMs: 1_000 } },
      job.version,
    );
    expect(edited._unsafeUnwrap().schedule.nextFireAt).toBeNull();
  });

  it('catches up once after downtime with run_once', async () => {
    const job = await createJob('/ok', {
      policy: { misfire: { mode: 'run_once', graceMs: 10_000 } },
    });
    current = new Date((job.schedule.nextFireAt ?? current).getTime() + 10 * 60_000 + 30_000);
    await scheduler().tick();
    const runs = await runsOf(job.id);
    expect(runs.map((r) => r.reason)).toEqual(['catchup']);
    expect((await db.jobs.get(job.id))?.schedule.nextFireAt?.getTime()).toBeGreaterThan(
      current.getTime(),
    );
  });

  it('forbid excludes a concurrent run whose claim timestamp is older', async () => {
    const job = await createJob('/slow', { policy: { overlap: 'forbid' } });
    await Promise.all([service().runNow(job.id), service().runNow(job.id)]);
    const executor = worker({ workerId: 'w1', concurrency: 1 });
    void executor.tick();
    await new Promise((r) => setTimeout(r, 200));
    // An earlier timestamp on the second claim simulates a stalled clock read.
    const late = await db.queue.claimNext({ workerId: 'w2', now: clock.now(), leaseMs: 30_000 });
    if (!late) {
      throw new Error('expected a second claimable run');
    }
    await worker({ workerId: 'w2' }).process({ ...late, startedAt: new Date(0) });
    await executor.stop();
    const statuses = (await runsOf(job.id)).map((r) => r.status).toSorted();
    expect(statuses).toEqual(['skipped', 'succeeded']);
  });

  it('notifies lifecycle listeners when a pending run is cancelled', async () => {
    const job = await createJob('/ok');
    const run = (await service().runNow(job.id))._unsafeUnwrap();
    const seenStatuses: string[] = [];
    const cancelled = await service([
      { onRunFinished: async (r) => void seenStatuses.push(r.status) },
    ]).cancelRun(run.id);
    expect(cancelled._unsafeUnwrap().status).toBe('cancelled');
    expect(seenStatuses).toEqual(['cancelled']);
    const summary = await db.analytics.summary({
      from: new Date(0),
      to: new Date(current.getTime() + 60_000),
      jobId: job.id,
    });
    expect(summary.byStatus).toEqual({ cancelled: 1 });
  });

  it('reaps a cancel-requested run as cancelled instead of retrying it', async () => {
    const job = await createJob('/ok', { policy: { retry: { maxAttempts: 3, delayMs: 0 } } });
    await service().runNow(job.id);
    const claimed = await db.queue.claimNext({
      workerId: 'dead',
      now: clock.now(),
      leaseMs: 1_000,
    });
    if (!claimed) {
      throw new Error('expected a claimable run');
    }
    await service().cancelRun(claimed.id);
    advance(2_000);
    await reaper().tick();
    expect((await runsOf(job.id))[0]?.status).toBe('cancelled');
  });

  it('validates configuration and previews the schedule', () => {
    const invalid = service().validate({
      name: 'x',
      trigger: { type: 'cron', config: { expression: 'bad' } },
      target: { type: 'nope', config: {} },
    });
    expect(invalid._unsafeUnwrapErr().issues.map((i) => i.path)).toEqual([
      'trigger.config.expression',
      'target.type',
    ]);
    const valid = service().validate({
      name: 'x',
      trigger: { type: 'cron', config: { expression: '*/5 * * * *' } },
      target: { type: 'http', config: { url: base } },
    });
    expect(valid._unsafeUnwrap().preview.nextFireTimes).toHaveLength(5);
  });
});
