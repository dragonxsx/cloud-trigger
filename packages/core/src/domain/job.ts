import { z } from 'zod';

import { ConnectionRef, TargetRef } from './connection.js';
import { GroupId, JobId, WorkflowId } from './ids.js';
import { JobPolicyPatch } from './policy.js';
import { ProviderRef } from './provider-ref.js';

export const NotificationEvent = z.enum(['success', 'failure', 'permanent_failure', 'late']);
export type NotificationEvent = z.output<typeof NotificationEvent>;

export const NotificationRule = z.object({
  on: z.array(NotificationEvent).min(1),
  notifier: ProviderRef,
});
export type NotificationRule = z.output<typeof NotificationRule>;

export const TriggerRef = ProviderRef.extend({
  connection: ConnectionRef.optional().describe(
    'Saved connection an event source consumes over; an endpoint supplies a saved source config.',
  ),
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
  successDeadline: z
    .date()
    .nullable()
    .default(null)
    .describe('When the since-last-success SLA breaks if no run succeeds before then.'),
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
  target: TargetRef,
  notifications: z.array(NotificationRule).default([]),
  policy: JobPolicyPatch.prefault({}),
});
export type JobSpec = z.output<typeof JobSpec>;
export type JobSpecInput = z.input<typeof JobSpec>;

export const Job = JobSpec.extend({
  id: JobId,
  pausedReason: z.string().nullable(),
  upstreamJobIds: z
    .array(JobId)
    .default([])
    .describe('Jobs whose runs trigger this one, from an event trigger such as after_job.'),
  eventSource: z
    .string()
    .nullable()
    .default(null)
    .describe('Trigger type of a long-lived event source (sqs, kafka, nats) the consumers poll.'),
  connectionRefs: z
    .array(ConnectionRef)
    .default([])
    .describe(
      'Connections and endpoints the trigger and target use, derived from the spec on save.',
    ),
  slaBreachedAt: z
    .date()
    .nullable()
    .default(null)
    .describe('Set when the job broke its since-last-success SLA; cleared by the next success.'),
  workflowId: WorkflowId.nullable()
    .default(null)
    .describe('Set on inline workflow jobs, which are created and deleted with their workflow.'),
  schedule: ScheduleState,
  version: z.int().min(1),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Job = z.output<typeof Job>;

export const successDeadlineAfter = (
  since: Date,
  maxSinceLastSuccessMs: number | undefined,
): Date | null =>
  maxSinceLastSuccessMs === undefined ? null : new Date(since.getTime() + maxSinceLastSuccessMs);

export const initialSchedule = (
  nextFireAt: Date | null,
  successDeadline: Date | null = null,
): ScheduleState => ({
  nextFireAt,
  lastFiredAt: null,
  lastSuccessAt: null,
  fireCount: 0,
  consecutiveFailures: 0,
  successDeadline,
});

export function createJob(params: {
  id: JobId;
  spec: JobSpec;
  nextFireAt: Date | null;
  successDeadline?: Date | null;
  upstreamJobIds?: readonly JobId[];
  connectionRefs?: readonly ConnectionRef[];
  eventSource?: string | null;
  workflowId?: WorkflowId | null;
  now: Date;
}): Job {
  return {
    ...params.spec,
    id: params.id,
    pausedReason: null,
    upstreamJobIds: [...(params.upstreamJobIds ?? [])],
    connectionRefs: [...(params.connectionRefs ?? [])],
    eventSource: params.eventSource ?? null,
    workflowId: params.workflowId ?? null,
    slaBreachedAt: null,
    schedule: initialSchedule(
      params.spec.enabled ? params.nextFireAt : null,
      params.successDeadline ??
        successDeadlineAfter(params.now, params.spec.policy.sla?.maxSinceLastSuccessMs),
    ),
    version: 1,
    createdAt: params.now,
    updatedAt: params.now,
  };
}

export const isSchedulable = (job: Job): boolean => job.enabled && job.pausedReason === null;
