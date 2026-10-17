import {
  type Job,
  JobSpec,
  type JobSpecInput,
  type PendingRun,
  createJob,
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
    ...(p.key !== undefined && { idempotencyKey: p.key }),
    now: T0,
  });
