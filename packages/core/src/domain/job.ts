import { z } from 'zod';

import { GroupId, JobId } from './ids.js';
import { JobPolicy } from './policy.js';
import { ProviderRef } from './provider-ref.js';

export const NotificationEvent = z.enum(['success', 'failure', 'permanent_failure', 'late']);
export type NotificationEvent = z.output<typeof NotificationEvent>;

export const NotificationRule = z.object({
  on: z.array(NotificationEvent).min(1),
  notifier: ProviderRef,
});
export type NotificationRule = z.output<typeof NotificationRule>;

export const TriggerRef = ProviderRef.extend({
  jitterMs: z
    .int()
    .min(0)
    .default(0)
    .describe('Random delay added to each scheduled fire time, capped before the next fire time.'),
});
export type TriggerRef = z.output<typeof TriggerRef>;

export const ScheduleState = z.object({
  nextFireAt: z.date().nullable(),
  lastFiredAt: z.date().nullable(),
  lastSuccessAt: z.date().nullable(),
  fireCount: z.int().min(0),
  consecutiveFailures: z.int().min(0),
});
export type ScheduleState = z.output<typeof ScheduleState>;

export const JobSpec = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2_000).default(''),
  tags: z.array(z.string().trim().min(1).max(64)).max(50).default([]),
  groupId: GroupId.nullable().default(null),
  enabled: z.boolean().default(true),
  input: ProviderRef.default({ type: 'static', config: { format: 'none' } }),
  trigger: TriggerRef,
  target: ProviderRef,
  notifications: z.array(NotificationRule).default([]),
  policy: JobPolicy.prefault({}),
});
export type JobSpec = z.output<typeof JobSpec>;
export type JobSpecInput = z.input<typeof JobSpec>;

export const Job = JobSpec.extend({
  id: JobId,
  pausedReason: z.string().nullable(),
  schedule: ScheduleState,
  version: z.int().min(1),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Job = z.output<typeof Job>;

export const initialSchedule = (nextFireAt: Date | null): ScheduleState => ({
  nextFireAt,
  lastFiredAt: null,
  lastSuccessAt: null,
  fireCount: 0,
  consecutiveFailures: 0,
});

export function createJob(params: {
  id: JobId;
  spec: JobSpec;
  nextFireAt: Date | null;
  now: Date;
}): Job {
  return {
    ...params.spec,
    id: params.id,
    pausedReason: null,
    schedule: initialSchedule(params.spec.enabled ? params.nextFireAt : null),
    version: 1,
    createdAt: params.now,
    updatedAt: params.now,
  };
}

export const isSchedulable = (job: Job): boolean => job.enabled && job.pausedReason === null;
