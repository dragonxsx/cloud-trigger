import { describe, expect, it } from 'vitest';

import { newJobId, newRunId } from './ids.js';
import { initialSchedule } from './job.js';
import { newPendingRun, startRun } from './run.js';
import { checkJobSla, checkRunSla } from './sla.js';

const t0 = new Date('2026-01-01T00:00:00Z');
const at = (ms: number) => new Date(t0.getTime() + ms);
const sla = { maxStartDelayMs: 1_000, maxDurationMs: 5_000 };
const job = { id: newJobId(), name: 'ping', version: 1, groupId: null };
const pending = newPendingRun({
  id: newRunId(),
  job,
  reason: 'scheduled',
  scheduledAt: t0,
  sla,
  now: t0,
});

describe('SLA checks', () => {
  it('flags a run that has not started in time', () => {
    expect(checkRunSla(pending, sla, at(999))).toEqual({ reasons: [], nextDeadline: at(1_000) });
    expect(checkRunSla(pending, sla, at(1_000)).reasons).toEqual([
      'Not started within 1000 ms of its scheduled time',
    ]);
  });

  it('flags a late start and an overrun once running', () => {
    const onTime = startRun(pending, { workerId: 'w', leaseMs: 1_000, now: at(500) });
    expect(checkRunSla(onTime, sla, at(600))).toEqual({ reasons: [], nextDeadline: at(5_500) });
    expect(checkRunSla(onTime, sla, at(5_500)).reasons).toEqual(['Still running after 5000 ms']);
    const lateStart = startRun(pending, { workerId: 'w', leaseMs: 1_000, now: at(2_000) });
    expect(checkRunSla(lateStart, sla, at(2_001)).reasons).toEqual([
      'Started 2000 ms after its scheduled time',
    ]);
  });

  it('flags a job without a recent success', () => {
    const fresh = { createdAt: t0, schedule: initialSchedule(null) };
    const limit = { maxSinceLastSuccessMs: 10_000 };
    expect(checkJobSla(fresh, limit, at(9_999))).toEqual({ reasons: [], nextDeadline: at(10_000) });
    expect(checkJobSla(fresh, limit, at(10_000)).reasons).toHaveLength(1);
    const succeeded = { ...fresh, schedule: { ...fresh.schedule, lastSuccessAt: at(8_000) } };
    expect(checkJobSla(succeeded, limit, at(10_000)).nextDeadline).toEqual(at(18_000));
    expect(checkJobSla(fresh, {}, at(99_999))).toEqual({ reasons: [], nextDeadline: null });
  });
});
