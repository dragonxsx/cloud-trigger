import type { NotifyFailure, RunLifecycleEvent } from '@cloud-trigger/core';

export const eventScope = (event: RunLifecycleEvent) => ({
  event: event.event,
  idempotencyKey: event.idempotencyKey,
  job: { id: event.jobId, name: event.jobName },
  run: {
    id: event.runId,
    status: event.status,
    attempt: event.attempt,
    scheduledAt: event.scheduledAt?.toISOString() ?? null,
  },
  result: event.result,
  lateReasons: event.lateReasons,
  occurredAt: event.occurredAt.toISOString(),
});

export const DEFAULT_SUMMARY =
  '[{{ event }}] {{ job.name }}: {{ run.status }}{% if result.error %} ({{ result.error.message }}){% endif %}';

export const isRetryableStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500;

export const failure = (message: string, retryable: boolean): NotifyFailure => ({
  message,
  retryable,
});
