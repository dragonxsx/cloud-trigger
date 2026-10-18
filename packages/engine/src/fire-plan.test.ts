import { MisfirePolicy, newJobId } from '@cloud-trigger/core';
import { intervalTrigger } from '@cloud-trigger/providers-builtin';
import { describe, expect, it } from 'vitest';

import { jitteredAvailableAt, planFires } from './fire-plan.js';

const minute = 60_000;
const t = (m: number) => new Date(Date.UTC(2026, 0, 1, 0, m));
const trigger = intervalTrigger.bind({ every: 1, unit: 'minutes' })._unsafeUnwrap();
const job = (nextFireAt: Date, fireCount = 0) => ({
  id: newJobId(),
  schedule: {
    nextFireAt,
    lastFiredAt: null,
    lastSuccessAt: null,
    fireCount,
    consecutiveFailures: 0,
    successDeadline: null,
  },
});
const plan = (
  mode: 'skip' | 'run_once' | 'run_all',
  now: Date,
  extra: Partial<MisfirePolicy> = {},
) =>
  planFires({
    job: job(t(0)),
    trigger,
    misfire: MisfirePolicy.parse({ mode, graceMs: 30_000, ...extra }),
    now,
  });

describe('planFires', () => {
  it('fires on time and computes the next fire', () => {
    const p = plan('skip', new Date(t(0).getTime() + 1_000));
    expect(p.fires).toEqual([{ scheduledAt: t(0), reason: 'scheduled' }]);
    expect(p.nextFireAt).toEqual(t(1));
  });

  it('skip drops missed fires; run_once runs a single catch-up; run_all runs all', () => {
    const pastGraceOfLastFire = new Date(t(5).getTime() + 40_000);
    expect(plan('skip', pastGraceOfLastFire).fires).toEqual([]);
    expect(plan('skip', pastGraceOfLastFire).skippedCount).toBe(6);
    expect(plan('run_once', pastGraceOfLastFire).fires).toEqual([
      { scheduledAt: t(5), reason: 'catchup' },
    ]);
    expect(plan('run_all', pastGraceOfLastFire).fires).toHaveLength(6);
    expect(plan('run_all', pastGraceOfLastFire).nextFireAt).toEqual(t(6));
  });

  it('caps catch-up and resumes in the future', () => {
    const p = plan('run_all', t(10_000), { maxCatchup: 3 });
    expect(p.fires.length).toBeLessThanOrEqual(4);
    expect(p.nextFireAt?.getTime()).toBeGreaterThan(t(10_000).getTime());
  });

  it('keeps the on-time fire when the catch-up cap is reached', () => {
    const p = plan('skip', t(10), { maxCatchup: 3 });
    expect(p.fires).toEqual([{ scheduledAt: t(10), reason: 'scheduled' }]);
    expect(p.nextFireAt).toEqual(t(11));
  });

  it('run_once catches up the latest missed fire even past the cap', () => {
    const p = plan('run_once', new Date(t(10).getTime() + 40_000), { maxCatchup: 3 });
    expect(p.fires).toEqual([{ scheduledAt: t(10), reason: 'catchup' }]);
    expect(p.nextFireAt).toEqual(t(11));
  });

  it('run_all enqueues at most maxCatchup missed fires', () => {
    const p = plan('run_all', new Date(t(10).getTime() + 40_000), { maxCatchup: 3 });
    expect(p.fires.map((f) => f.scheduledAt)).toEqual([t(0), t(1), t(2)]);
  });

  it('keeps the latest due fire when the grace window holds more than the cap', () => {
    const p = plan('skip', t(10), { maxCatchup: 2, graceMs: 60 * minute });
    expect(p.fires.map((f) => f.scheduledAt)).toEqual([t(0), t(10)]);
    expect(p.nextFireAt).toEqual(t(11));
  });

  it('counts only planned fires toward maxCount', () => {
    const capped = intervalTrigger.bind({ every: 1, unit: 'minutes', maxCount: 2 })._unsafeUnwrap();
    const after = new Date(t(1).getTime() + 40_000);
    const planWith = (mode: 'skip' | 'run_once' | 'run_all') =>
      planFires({
        job: job(t(0)),
        trigger: capped,
        misfire: MisfirePolicy.parse({ mode, graceMs: 30_000 }),
        now: after,
      });

    const skipped = planWith('skip');
    expect(skipped.fires).toEqual([]);
    expect(skipped.nextFireAt).toEqual(t(2));

    const once = planWith('run_once');
    expect(once.fires).toEqual([{ scheduledAt: t(1), reason: 'catchup' }]);
    expect(once.nextFireAt).toEqual(t(2));

    const all = planWith('run_all');
    expect(all.fires).toHaveLength(2);
    expect(all.nextFireAt).toBeNull();
  });

  it('jitter never passes the next fire time', () => {
    expect(jitteredAvailableAt(t(0), 10 * minute, t(1), () => 0.999).getTime()).toBeLessThan(
      t(1).getTime(),
    );
    expect(jitteredAvailableAt(t(0), 0, t(1))).toEqual(t(0));
  });
});
