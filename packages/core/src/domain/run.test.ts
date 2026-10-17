import { describe, expect, it } from 'vitest';

import { newJobId, newRunId } from './ids.js';
import { RetryPolicy } from './policy.js';
import { cancelPendingRun, expireLease, finishAttempt, newPendingRun, startRun } from './run.js';

const t0 = new Date('2026-01-01T00:00:00Z');
const at = (ms: number) => new Date(t0.getTime() + ms);
const job = { id: newJobId(), name: 'ping', version: 1 };
const pending = () =>
  newPendingRun({ id: newRunId(), job, reason: 'scheduled', scheduledAt: t0, now: t0 });
const running = () => startRun(pending(), { workerId: 'w1', leaseMs: 10_000, now: at(10) });

const failureWithBody = (body: string) => ({
  outcome: 'failure' as const,
  durationMs: 1,
  response: { body, sizeBytes: body.length, truncated: false },
  error: { code: 'http_503', message: 'x', retryable: true },
});

describe('run state machine', () => {
  it('starts a pending run under a lease', () => {
    const run = running();
    expect(run.status).toBe('running');
    expect(run.lease).toEqual({ workerId: 'w1', until: at(10_010) });
  });

  it('succeeds on a successful result', () => {
    const next = finishAttempt(running(), {
      result: { outcome: 'success', durationMs: 5, statusCode: 200 },
      retry: RetryPolicy.parse({ maxAttempts: 3 }),
      now: at(20),
    });
    expect(next.status).toBe('succeeded');
    expect(next.attempts).toHaveLength(1);
  });

  it('retries a retryable failure with exponential backoff', () => {
    const retry = RetryPolicy.parse({ maxAttempts: 3, delayMs: 1_000 });
    const failure = {
      outcome: 'failure' as const,
      durationMs: 1,
      error: { code: 'http_503', message: 'x', retryable: true },
    };
    const first = finishAttempt(running(), { result: failure, retry, now: at(20) });
    expect(first.status).toBe('pending');
    if (first.status !== 'pending') {
      return;
    }
    expect(first.availableAt).toEqual(at(1_020));

    const second = finishAttempt(startRun(first, { workerId: 'w2', leaseMs: 1, now: at(1_020) }), {
      result: failure,
      retry,
      now: at(1_030),
    });
    if (second.status !== 'pending') {
      throw new Error('expected retry');
    }
    expect(second.availableAt).toEqual(at(3_030));

    const third = finishAttempt(startRun(second, { workerId: 'w2', leaseMs: 1, now: at(3_030) }), {
      result: failure,
      retry,
      now: at(3_040),
    });
    expect(third.status).toBe('failed');
    expect(third.attempts.map((a) => a.attempt)).toEqual([1, 2, 3]);
  });

  it('keeps the response body only on the latest attempt', () => {
    const retry = RetryPolicy.parse({ maxAttempts: 2, delayMs: 0 });
    const first = finishAttempt(running(), {
      result: failureWithBody('first'),
      retry,
      now: at(20),
    });
    if (first.status !== 'pending') {
      throw new Error('expected retry');
    }
    const second = finishAttempt(startRun(first, { workerId: 'w2', leaseMs: 1, now: at(30) }), {
      result: failureWithBody('second'),
      retry,
      now: at(40),
    });
    expect(second.attempts.map((a) => a.result.response)).toEqual([
      { sizeBytes: 5, truncated: true },
      { body: 'second', sizeBytes: 6, truncated: false },
    ]);
  });

  it('does not retry non-retryable failures and maps timeouts', () => {
    const retry = RetryPolicy.parse({ maxAttempts: 5 });
    const nonRetryable = finishAttempt(running(), {
      result: {
        outcome: 'failure',
        durationMs: 1,
        error: { code: 'http_400', message: 'bad', retryable: false },
      },
      retry,
      now: at(20),
    });
    expect(nonRetryable.status).toBe('failed');

    const timeout = finishAttempt(running(), {
      result: {
        outcome: 'failure',
        durationMs: 1,
        error: { code: 'timeout', message: 't', retryable: false },
      },
      retry,
      now: at(20),
    });
    expect(timeout.status).toBe('timed_out');
  });

  it('requeues on lease expiry and cancels pending runs', () => {
    const expired = expireLease(running(), {
      retry: RetryPolicy.parse({ maxAttempts: 2 }),
      now: at(20_000),
    });
    expect(expired.status).toBe('pending');
    expect(cancelPendingRun(pending(), at(5)).status).toBe('cancelled');
  });

  it('recovers an expired run whose cancellation was requested as cancelled', () => {
    const expired = expireLease(
      { ...running(), cancelRequested: true },
      { retry: RetryPolicy.parse({ maxAttempts: 3 }), now: at(20_000) },
    );
    expect(expired.status).toBe('cancelled');
    expect(expired.attempts[0]?.result.error?.retryable).toBe(false);
  });
});
