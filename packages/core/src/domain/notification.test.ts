import { describe, expect, it } from 'vitest';

import { newJobId, newRunId } from './ids.js';
import { eventsForFinishedRun, newDeliveries } from './notification.js';
import { cancelPendingRun, newPendingRun } from './run.js';

const t0 = new Date('2026-01-01T00:00:00Z');
const job = { id: newJobId(), name: 'ping', version: 1, groupId: null };
const pending = newPendingRun({
  id: newRunId(),
  job,
  reason: 'scheduled',
  scheduledAt: t0,
  sla: {},
  now: t0,
});
const webhook = { type: 'webhook', config: { url: 'http://x' } };

describe('notifications', () => {
  it('maps terminal statuses to events', () => {
    const finished = (status: 'succeeded' | 'failed' | 'timed_out') => ({
      ...cancelPendingRun(pending, t0),
      status,
    });
    expect(eventsForFinishedRun(finished('succeeded'))).toEqual(['success']);
    expect(eventsForFinishedRun(finished('failed'))).toEqual(['permanent_failure']);
    expect(eventsForFinishedRun(finished('timed_out'))).toEqual(['permanent_failure']);
    expect(eventsForFinishedRun(cancelPendingRun(pending, t0))).toEqual([]);
  });

  it('creates one keyed delivery per matching rule', () => {
    const deliveries = newDeliveries({
      rules: [
        { on: ['success'], notifier: webhook },
        { on: ['failure', 'permanent_failure'], notifier: webhook },
        { on: ['permanent_failure'], notifier: webhook },
      ],
      subject: pending.id,
      now: t0,
      event: {
        event: 'permanent_failure',
        jobId: job.id,
        jobName: job.name,
        runId: pending.id,
        status: 'failed',
        attempt: 3,
        scheduledAt: t0,
        lateReasons: [],
        result: null,
        occurredAt: t0,
      },
    });
    expect(deliveries.map((d) => d.key)).toEqual([
      `notify:${pending.id}:permanent_failure:1`,
      `notify:${pending.id}:permanent_failure:2`,
    ]);
    expect(deliveries[0]?.payload.idempotencyKey).toBe(deliveries[0]?.key);
    expect(deliveries[0]).toMatchObject({ status: 'pending', attempts: 0, availableAt: t0 });
  });
});
