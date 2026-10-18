import { z } from 'zod';

import { assertNever } from '../shared/assert-never.js';
import { JobId, NotificationId, RunId, newNotificationId } from './ids.js';
import { NotificationEvent, type NotificationRule } from './job.js';
import { ProviderRef } from './provider-ref.js';
import { type FinishedRun, Lease, type PendingRun, type SkippedRun } from './run.js';
import { TargetResult } from './target-result.js';

export const RunLifecycleEvent = z.object({
  event: NotificationEvent,
  idempotencyKey: z
    .string()
    .describe('Stable per delivery; receivers can use it to drop redeliveries.'),
  jobId: JobId,
  jobName: z.string(),
  runId: RunId.nullable().describe('Null for job-level events such as a since-last-success SLA.'),
  status: z.string(),
  attempt: z.int().min(0),
  scheduledAt: z.date().nullable(),
  lateReasons: z.array(z.string()),
  result: TargetResult.nullable(),
  occurredAt: z.date(),
});
export type RunLifecycleEvent = z.output<typeof RunLifecycleEvent>;

export const DeliveryStatus = z.enum(['pending', 'sending', 'delivered', 'failed']);
export type DeliveryStatus = z.output<typeof DeliveryStatus>;

export const NotificationDelivery = z.object({
  id: NotificationId,
  key: z.string(),
  jobId: JobId,
  runId: RunId.nullable(),
  event: NotificationEvent,
  ruleIndex: z.int().min(0),
  notifier: ProviderRef,
  payload: RunLifecycleEvent,
  status: DeliveryStatus,
  attempts: z.int().min(0),
  availableAt: z.date(),
  lease: Lease.nullable(),
  lastError: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  deliveredAt: z.date().nullable(),
});
export type NotificationDelivery = z.output<typeof NotificationDelivery>;

export function eventsForFinishedRun(run: FinishedRun | SkippedRun): readonly NotificationEvent[] {
  const { status } = run;
  switch (status) {
    case 'succeeded':
      return ['success'];
    case 'failed':
    case 'timed_out':
      return ['permanent_failure'];
    case 'cancelled':
    case 'skipped':
      return [];
    default:
      return assertNever(status);
  }
}

export const isFailedRetry = (previous: { attempts: readonly unknown[] }, next: PendingRun) =>
  next.attempts.length > previous.attempts.length &&
  next.attempts.at(-1)?.result.outcome === 'failure';

export const notificationKey = (subject: string, event: NotificationEvent, ruleIndex: number) =>
  `notify:${subject}:${event}:${ruleIndex}`;

export function newDeliveries(p: {
  rules: readonly NotificationRule[];
  event: Omit<RunLifecycleEvent, 'idempotencyKey'>;
  subject: string;
  now: Date;
}): NotificationDelivery[] {
  return p.rules.flatMap((rule, ruleIndex) => {
    if (!rule.on.includes(p.event.event)) {
      return [];
    }
    const key = notificationKey(p.subject, p.event.event, ruleIndex);

    return [
      {
        id: newNotificationId(),
        key,
        jobId: p.event.jobId,
        runId: p.event.runId,
        event: p.event.event,
        ruleIndex,
        notifier: rule.notifier,
        payload: { ...p.event, idempotencyKey: key },
        status: 'pending',
        attempts: 0,
        availableAt: p.now,
        lease: null,
        lastError: null,
        createdAt: p.now,
        updatedAt: p.now,
        deliveredAt: null,
      },
    ];
  });
}
