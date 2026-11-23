import {
  type EngineMetrics,
  type EngineSignal,
  newPendingRun,
  newRunId,
  silentLogger,
  skipClaimedRun,
} from '@cloud-trigger/core';
import { describe, expect, it } from 'vitest';

import { Reaper, RunCompletion, Scheduler } from '../src/index.js';
import { useHarness } from './harness.js';

const h = useHarness('engine_metrics');

const recorder = (): EngineMetrics & { readonly signals: EngineSignal[] } => {
  const signals: EngineSignal[] = [];

  return { signals, record: (signal) => signals.push(signal) };
};

const scheduler = (metrics: EngineMetrics) =>
  new Scheduler(
    { ...h.db, registry: h.registry, clock: h.clock, logger: silentLogger, metrics },
    { ownerId: 's1', intervalMs: 1_000, claimLeaseMs: 30_000, batchSize: 50 },
  );

const kinds = (signals: readonly EngineSignal[]) => signals.map((s) => s.kind);

describe('engine metrics', () => {
  it('records scheduled fires and the start lag of the first attempt', async () => {
    const metrics = recorder();
    const job = await h.createJob('/ok');
    h.setNow(job.schedule.nextFireAt ?? h.now());
    await scheduler(metrics).tick();
    h.advance(1_500);
    await h.settle(h.worker({}, { metrics }));

    expect(metrics.signals).toContainEqual({ kind: 'fired', reason: 'scheduled', count: 1 });
    expect(metrics.signals).toContainEqual({
      kind: 'attempt_started',
      reason: 'scheduled',
      targetType: 'http',
      attempt: 1,
      lagMs: 1_500,
    });
  });

  it('does not count a fire whose run was already queued', async () => {
    const metrics = recorder();
    const job = await h.createJob('/ok');
    const fireAt = job.schedule.nextFireAt ?? h.now();
    h.setNow(fireAt);
    await h.db.runs.insert(
      newPendingRun({
        id: newRunId(),
        job,
        reason: 'scheduled',
        scheduledAt: fireAt,
        idempotencyKey: `sched:${job.id}:${fireAt.toISOString()}`,
        sla: {},
        now: h.now(),
      }),
    );
    await scheduler(metrics).tick();

    expect(kinds(metrics.signals)).not.toContain('fired');
  });

  it('records catch-up fires and the decision behind them', async () => {
    const metrics = recorder();
    const job = await h.createJob('/ok', {
      policy: { misfire: { mode: 'run_once', graceMs: 10_000 } },
    });
    h.setNow(new Date((job.schedule.nextFireAt ?? h.now()).getTime() + 10 * 60_000 + 30_000));
    await scheduler(metrics).tick();

    expect(metrics.signals).toContainEqual({ kind: 'fired', reason: 'catchup', count: 1 });
    expect(metrics.signals).toContainEqual({ kind: 'decision', decision: 'catchup' });
  });

  it('records lease expirations recovered by the reaper', async () => {
    const metrics = recorder();
    const job = await h.createJob('/ok');
    await h.service().runNow(job.id);
    await h.db.queue.claimNext({ workerId: 'dead', now: h.now(), leaseMs: 1_000 });
    h.advance(2_000);
    await new Reaper(
      { ...h.db, clock: h.clock, logger: silentLogger, listeners: h.listeners(), metrics },
      { intervalMs: 1_000, batchSize: 10 },
    ).tick();

    expect(kinds(metrics.signals)).toContain('lease_expired');
  });

  it('records a commit that lost the race to a concurrent update', async () => {
    const metrics = recorder();
    const job = await h.createJob('/ok');
    await h.service().runNow(job.id);
    const claimed = await h.db.queue.claimNext({ workerId: 'w', now: h.now(), leaseMs: 30_000 });
    if (!claimed) {
      throw new Error('expected a claimable run');
    }
    const completion = new RunCompletion({
      ...h.db,
      clock: h.clock,
      logger: silentLogger,
      listeners: [],
      metrics,
    });
    const skipped = skipClaimedRun(claimed, { reason: 'test', now: h.now() });

    expect((await completion.commit(claimed, skipped, job)).isOk()).toBe(true);
    expect((await completion.commit(claimed, skipped, job)).isErr()).toBe(true);
    expect(kinds(metrics.signals)).toEqual(['stale_commit']);
  });
});
