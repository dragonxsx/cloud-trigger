import {
  type JobRepository,
  type RunAnalytics,
  type RunQueue,
  type RunRepository,
  type RunningRun,
  type ScheduleStore,
  finishAttempt,
  RetryPolicy,
} from '@cloud-trigger/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { T0, at, makeJob, makePendingRun } from './fixtures.js';

export interface PortsUnderTest {
  readonly jobs: JobRepository;
  readonly schedule: ScheduleStore;
  readonly runs: RunRepository;
  readonly queue: RunQueue;
  readonly analytics: RunAnalytics;
}

const claimOne = async ({ jobs, runs, queue }: PortsUnderTest) => {
  const job = makeJob();
  await jobs.insert(job);
  await runs.insert(makePendingRun(job));
  const running = await queue.claimNext({ workerId: 'w1', now: at(5), leaseMs: 1_000 });
  if (!running) {
    throw new Error('expected a claim');
  }

  return running;
};
const succeed = (running: RunningRun) =>
  finishAttempt(running, {
    result: { outcome: 'success', durationMs: 3 },
    retry: RetryPolicy.parse({}),
    now: at(10),
  });

export function describePersistenceContract(
  name: string,
  setup: { ports: () => PortsUnderTest; reset: () => Promise<void> },
) {
  describe(`${name}: persistence contract`, () => {
    beforeEach(() => setup.reset());

    describe('JobRepository', () => {
      it('round-trips a job and pages newest first', async () => {
        const { jobs } = setup.ports();
        const a = makeJob({ name: 'alpha', tags: ['x'] });
        const b = makeJob({ name: 'beta' });
        await jobs.insert(a);
        await jobs.insert(b);
        expect(await jobs.get(a.id)).toEqual(a);
        const page1 = await jobs.list({ limit: 1 });
        expect(page1.items.map((j) => j.name)).toEqual(['beta']);
        const page2 = await jobs.list({ limit: 1, cursor: page1.nextCursor ?? undefined });
        expect(page2.items.map((j) => j.name)).toEqual(['alpha']);
        expect(page2.nextCursor).toBeNull();
        expect(page1.total).toBe(2);
        const byOffset = await jobs.list({ limit: 1, offset: 1 });
        expect(byOffset.items.map((j) => j.name)).toEqual(['alpha']);
        expect((await jobs.list({ limit: 10, tag: 'x' })).items).toHaveLength(1);
        expect((await jobs.list({ limit: 10, search: 'ALP' })).items).toHaveLength(1);
      });

      it('enforces optimistic concurrency', async () => {
        const { jobs } = setup.ports();
        const job = makeJob();
        await jobs.insert(job);
        const edit = (newName: string) => ({ spec: { ...job, name: newName }, updatedAt: at(1) });
        const updated = await jobs.update(job.id, edit('renamed'), 1);
        expect(updated._unsafeUnwrap().version).toBe(2);
        expect((await jobs.update(job.id, edit('stale'), 1))._unsafeUnwrapErr().code).toBe(
          'version_conflict',
        );
        expect((await jobs.update(makeJob().id, edit('x'), 1))._unsafeUnwrapErr().code).toBe(
          'not_found',
        );
        expect((await jobs.get(job.id))?.name).toBe('renamed');
      });

      it('keeps concurrent scheduler and pause state when editing', async () => {
        const { jobs } = setup.ports();
        const job = makeJob();
        await jobs.insert(job);
        // The scheduler advances and the user pauses after the editor read version 1.
        await jobs.patchSchedule(
          job.id,
          { nextFireAt: at(60_000), fireCount: 1 },
          { pausedReason: 'Paused by user' },
        );

        const renamed = await jobs.update(
          job.id,
          { spec: { ...job, name: 'renamed' }, updatedAt: at(1) },
          1,
        );
        expect(renamed._unsafeUnwrap()).toMatchObject({
          name: 'renamed',
          pausedReason: 'Paused by user',
          schedule: { nextFireAt: at(60_000), fireCount: 1 },
        });

        const reschedule = { nextFireAt: at(5), basedOn: job.schedule };
        const stale = await jobs.update(
          job.id,
          { spec: { ...job, enabled: false }, updatedAt: at(2), reschedule },
          2,
        );
        expect(stale._unsafeUnwrapErr().code).toBe('version_conflict');
        expect((await jobs.get(job.id))?.schedule.nextFireAt).toEqual(at(60_000));
      });

      it('counts concurrent failures atomically and auto-pauses at the threshold', async () => {
        const { jobs } = setup.ports();
        const job = makeJob();
        await jobs.insert(job);
        await Promise.all([1, 2, 3].map(() => jobs.recordFailure(job.id, { pauseAfter: 2 })));
        const stored = await jobs.get(job.id);
        expect(stored?.schedule.consecutiveFailures).toBe(3);
        expect(stored?.pausedReason).toMatch(/^Auto-paused after [23] consecutive failures$/);

        const other = makeJob();
        await jobs.insert(other);
        await jobs.recordFailure(other.id, {});
        expect((await jobs.get(other.id))?.pausedReason).toBeNull();
      });
    });

    describe('ScheduleStore', () => {
      it('hands each due job to exactly one claimer and dedupes fired runs', async () => {
        const { jobs, schedule, runs } = setup.ports();
        const due = makeJob({}, T0);
        await jobs.insert(due);
        await jobs.insert(makeJob({}, at(60_000)));
        await jobs.insert(makeJob({ enabled: false }, T0));

        const [first, second] = await Promise.all([
          schedule.claimDue({ now: at(1), ownerId: 's1', leaseMs: 5_000, limit: 10 }),
          schedule.claimDue({ now: at(1), ownerId: 's2', leaseMs: 5_000, limit: 10 }),
        ]);
        expect([...first, ...second].map((j) => j.id)).toEqual([due.id]);

        const run = makePendingRun(due, { key: `sched:${due.id}:${T0.toISOString()}` });
        const inserted = await schedule.commitFire({
          jobId: due.id,
          jobVersion: due.version,
          ownerId: first.length ? 's1' : 's2',
          now: at(2),
          runs: [run],
          schedule: { nextFireAt: at(60_000), lastFiredAt: T0, fireCount: 1 },
        });
        expect(inserted._unsafeUnwrap()).toHaveLength(1);
        expect((await jobs.get(due.id))?.schedule.nextFireAt).toEqual(at(60_000));

        const duplicate = makePendingRun(due, { key: `sched:${due.id}:${T0.toISOString()}` });
        expect((await runs.insert(duplicate))._unsafeUnwrapErr().code).toBe('duplicate_run');
      });

      it('writes nothing for a scheduler that lost its claim', async () => {
        const { jobs, schedule, runs } = setup.ports();
        const job = makeJob({}, T0);
        await jobs.insert(job);
        const fire = (ownerId: string, now: Date, key: string) =>
          schedule.commitFire({
            jobId: job.id,
            jobVersion: job.version,
            ownerId,
            now,
            runs: [makePendingRun(job, { key })],
            schedule: { nextFireAt: at(60_000), lastFiredAt: T0, fireCount: 1 },
          });

        await schedule.claimDue({ now: at(1), ownerId: 'old', leaseMs: 1_000, limit: 1 });
        expect((await fire('old', at(2_000), 'expired'))._unsafeUnwrapErr().code).toBe(
          'stale_claim',
        );
        await schedule.claimDue({ now: at(2_000), ownerId: 'new', leaseMs: 1_000, limit: 1 });
        expect((await fire('old', at(2_001), 'taken-over')).isErr()).toBe(true);
        expect(await runs.countByStatus(job.id, ['pending'])).toBe(0);
        expect((await jobs.get(job.id))?.schedule.fireCount).toBe(0);

        expect((await fire('new', at(2_001), 'current'))._unsafeUnwrap()).toHaveLength(1);
        expect(await runs.countByStatus(job.id, ['pending'])).toBe(1);
      });
      it('writes nothing when the job was edited after the claim', async () => {
        const { jobs, schedule, runs } = setup.ports();
        const job = makeJob({}, T0);
        await jobs.insert(job);
        const [claimed] = await schedule.claimDue({
          now: at(1),
          ownerId: 's1',
          leaseMs: 5_000,
          limit: 1,
        });
        expect(claimed?.id).toBe(job.id);
        const reschedule = { nextFireAt: null, basedOn: job.schedule };
        const edited = await jobs.update(
          job.id,
          { spec: { ...job, enabled: false }, updatedAt: at(2), reschedule },
          job.version,
        );
        expect(edited.isOk()).toBe(true);

        const committed = await schedule.commitFire({
          jobId: job.id,
          jobVersion: job.version,
          ownerId: 's1',
          now: at(3),
          runs: [makePendingRun(job, { key: 'stale-plan' })],
          schedule: { nextFireAt: at(60_000), lastFiredAt: T0, fireCount: 1 },
        });
        expect(committed._unsafeUnwrapErr().code).toBe('stale_claim');
        expect(await runs.countByStatus(job.id, ['pending'])).toBe(0);
        const stored = await jobs.get(job.id);
        expect(stored?.enabled).toBe(false);
        expect(stored?.schedule.nextFireAt).toBeNull();
      });
    });

    describe('RunQueue + RunRepository', () => {
      it('rejects a transition from a snapshot taken before the lease was renewed', async () => {
        const ports = setup.ports();
        const running = await claimOne(ports);
        const until = at(3_000);
        await ports.queue.renewLease({
          runId: running.id,
          workerId: running.lease.workerId,
          until,
        });
        expect((await ports.runs.transition(running, succeed(running))).isErr()).toBe(true);
        const renewed = { ...running, lease: { ...running.lease, until } };
        expect((await ports.runs.transition(renewed, succeed(running))).isOk()).toBe(true);
      });

      it('claims each pending run once, renews, cancels and CAS-transitions', async () => {
        const { jobs, runs, queue } = setup.ports();
        const job = makeJob();
        await jobs.insert(job);
        const pending = makePendingRun(job);
        await runs.insert(pending);

        const claims = await Promise.all([
          queue.claimNext({ workerId: 'w1', now: at(5), leaseMs: 1_000 }),
          queue.claimNext({ workerId: 'w2', now: at(5), leaseMs: 1_000 }),
        ]);
        const running = claims.find((c) => c !== undefined);
        expect(claims.filter((c) => c !== undefined)).toHaveLength(1);
        if (!running) {
          throw new Error('expected a claim');
        }

        const until = at(3_000);
        expect(await queue.renewLease({ runId: running.id, workerId: 'other', until })).toEqual({
          renewed: false,
          cancelRequested: false,
        });
        expect(await queue.requestCancel(running.id)).toBe(true);
        expect(
          await queue.renewLease({ runId: running.id, workerId: running.lease.workerId, until }),
        ).toEqual({
          renewed: true,
          cancelRequested: true,
        });
        expect(await queue.findExpired({ now: at(2_000), limit: 10 })).toHaveLength(0);
        expect(await queue.findExpired({ now: at(4_000), limit: 10 })).toHaveLength(1);

        const renewed = { ...running, lease: { ...running.lease, until } };
        expect((await runs.transition(renewed, succeed(running))).isOk()).toBe(true);
        expect((await runs.get(running.id))?.status).toBe('succeeded');
        expect(await runs.countByStatus(job.id, ['succeeded'])).toBe(1);
      });

      it('prunes history per job', async () => {
        const { jobs, runs, queue } = setup.ports();
        const job = makeJob();
        await jobs.insert(job);
        for (let i = 0; i < 5; i++) {
          await runs.insert(makePendingRun(job, { scheduledAt: at(i) }));
          const r = await queue.claimNext({ workerId: 'w', now: at(100), leaseMs: 1_000 });
          if (!r) {
            throw new Error('claim');
          }
          await runs.transition(
            r,
            finishAttempt(r, {
              result: { outcome: 'success', durationMs: 1 },
              retry: RetryPolicy.parse({}),
              now: at(200),
            }),
          );
        }
        expect(await runs.prune(job.id, { succeeded: 2, failed: 0 })).toBe(3);
        expect(await runs.countByStatus(job.id, ['succeeded'])).toBe(2);
      });
    });

    describe('RunAnalytics', () => {
      it('summarises, buckets and ranks errors', async () => {
        const { analytics } = setup.ports();
        const job = makeJob();
        const base = {
          jobId: job.id,
          targetType: 'http',
          attempts: 1,
          late: false,
          statusCode: 200,
        };
        for (let i = 0; i < 8; i++) {
          await analytics.record({
            ...base,
            ts: at(i * 60_000),
            status: 'succeeded',
            durationMs: 100 + i,
            errorCode: null,
          });
        }
        await analytics.record({
          ...base,
          ts: at(30_000),
          status: 'failed',
          durationMs: 900,
          errorCode: 'http_assertion',
        });
        await analytics.record({
          ...base,
          ts: at(90_000),
          status: 'failed',
          durationMs: 800,
          errorCode: 'http_assertion',
        });

        const range = { from: T0, to: at(3_600_000) };
        const summary = await analytics.summary(range);
        expect(summary.total).toBe(10);
        expect(summary.successRate).toBeCloseTo(0.8);
        expect(summary.p95Ms).toBeGreaterThan(100);

        const series = await analytics.timeseries({ ...range, bucket: 'minute' });
        expect(series[0]?.byStatus).toEqual({ succeeded: 1, failed: 1 });
        expect(series.reduce((n, p) => n + (p.byStatus.succeeded ?? 0), 0)).toBe(8);

        expect(await analytics.topErrors({ ...range, limit: 5 })).toEqual([
          { errorCode: 'http_assertion', jobId: job.id, count: 2 },
        ]);
      });
    });
  });
}
