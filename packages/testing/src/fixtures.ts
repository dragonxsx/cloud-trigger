import {
  type Job,
  type NotificationDelivery,
  JobSpec,
  type JobSpecInput,
  type PendingRun,
  createJob,
  newDeliveries,
  newJobId,
  newPendingRun,
  newRunId,
} from '@cloud-trigger/core';

export const T0 = new Date('2026-01-01T00:00:00.000Z');
export const at = (ms: number): Date => new Date(T0.getTime() + ms);

export const makeJob = (spec: Partial<JobSpecInput> = {}, nextFireAt: Date | null = T0): Job =>
  createJob({
    id: newJobId(),
    spec: JobSpec.parse({
      name: 'job',
      trigger: { type: 'interval', config: { every: 1, unit: 'minutes' } },
      target: { type: 'http', config: { url: 'http://localhost' } },
      ...spec,
    }),
    nextFireAt,
    now: T0,
  });

export const makePendingRun = (
  job: Job,
  p: { scheduledAt?: Date; key?: string } = {},
): PendingRun =>
  newPendingRun({
    id: newRunId(),
    job,
    reason: 'scheduled',
    scheduledAt: p.scheduledAt ?? T0,
    sla: job.policy.sla ?? {},
    ...(p.key !== undefined && { idempotencyKey: p.key }),
    now: T0,
  });

export const makeDelivery = (
  job: Job,
  p: { subject?: string; now?: Date } = {},
): NotificationDelivery => {
  const [delivery] = newDeliveries({
    rules: [
      { on: ['success'], notifier: { type: 'webhook', config: { url: 'http://localhost' } } },
    ],
    event: {
      event: 'success',
      jobId: job.id,
      jobName: job.name,
      runId: null,
      status: 'succeeded',
      attempt: 1,
      scheduledAt: T0,
      lateReasons: [],
      result: null,
      occurredAt: T0,
    },
    subject: p.subject ?? newRunId(),
    now: p.now ?? T0,
  });
  if (!delivery) {
    throw new Error('expected a delivery');
  }

  return delivery;
};
