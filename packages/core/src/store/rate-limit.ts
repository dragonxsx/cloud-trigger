import type { RateLimit } from '../domain/group.js';
import type { AcquireResult } from '../ports/groups.js';

export const DEFAULT_CONCURRENCY_RETRY_MS = 250;

export interface BucketState {
  readonly running: number;
  readonly tokens: number | null;
  readonly refilledAt: Date | null;
}

export interface AcquireAttempt {
  readonly granted: boolean;
  readonly running: number;
  readonly tokens: number | null;
}

export const bucketCapacity = (limit: RateLimit): number | undefined =>
  limit.perSecond === undefined ? undefined : Math.max(1, limit.perSecond);

export function attemptAcquire(limit: RateLimit, state: BucketState, now: Date): AcquireAttempt {
  const rate = limit.perSecond;
  const capacity = bucketCapacity(limit);
  const elapsedSeconds = (now.getTime() - (state.refilledAt ?? now).getTime()) / 1_000;
  const tokens =
    capacity === undefined || rate === undefined
      ? null
      : Math.min(capacity, (state.tokens ?? capacity) + elapsedSeconds * rate);
  const max = limit.maxConcurrent;
  const granted = (max === undefined || state.running < max) && (tokens === null || tokens >= 1);

  return {
    granted,
    running: max !== undefined && granted ? state.running + 1 : state.running,
    tokens: tokens === null || !granted ? tokens : tokens - 1,
  };
}

export function acquireResult(
  limit: RateLimit,
  attempt: AcquireAttempt,
  now: Date,
  concurrencyRetryMs = DEFAULT_CONCURRENCY_RETRY_MS,
): AcquireResult {
  if (attempt.granted) {
    return { ok: true, holdsSlot: limit.maxConcurrent !== undefined };
  }
  const tokens = attempt.tokens ?? 0;
  const waits = [
    limit.maxConcurrent !== undefined && attempt.running >= limit.maxConcurrent
      ? concurrencyRetryMs
      : 0,
    limit.perSecond !== undefined && tokens < 1
      ? Math.ceil(((1 - tokens) / limit.perSecond) * 1_000)
      : 0,
  ];

  return { ok: false, retryAt: new Date(now.getTime() + Math.max(1, ...waits)) };
}
