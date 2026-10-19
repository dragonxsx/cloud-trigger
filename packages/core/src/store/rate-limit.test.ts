import { describe, expect, it } from 'vitest';

import { acquireResult, attemptAcquire, bucketCapacity } from './rate-limit.js';

const now = new Date('2026-01-01T00:00:10Z');
const secondsAgo = (s: number) => new Date(now.getTime() - s * 1_000);

describe('token bucket', () => {
  it('bursts up to max(1, rate)', () => {
    expect(bucketCapacity({ perSecond: 0.5 })).toBe(1);
    expect(bucketCapacity({ perSecond: 5 })).toBe(5);
    expect(bucketCapacity({ maxConcurrent: 2 })).toBeUndefined();
  });

  it('starts full and spends one token per grant', () => {
    expect(
      attemptAcquire({ perSecond: 2 }, { running: 0, tokens: null, refilledAt: null }, now),
    ).toEqual({ granted: true, running: 0, tokens: 1 });
  });

  it('refills by elapsed time, capped at capacity', () => {
    const attempt = attemptAcquire(
      { perSecond: 2 },
      { running: 0, tokens: 0, refilledAt: secondsAgo(10) },
      now,
    );

    expect(attempt).toEqual({ granted: true, running: 0, tokens: 1 });
  });

  it('refuses an empty bucket and waits for the next token', () => {
    const limit = { perSecond: 4 };
    const attempt = attemptAcquire(limit, { running: 0, tokens: 0.5, refilledAt: now }, now);

    expect(attempt).toEqual({ granted: false, running: 0, tokens: 0.5 });
    expect(acquireResult(limit, attempt, now)).toEqual({
      ok: false,
      retryAt: new Date(now.getTime() + 125),
    });
  });
});

describe('concurrency slots', () => {
  it('takes a slot when one is free', () => {
    const limit = { maxConcurrent: 2 };
    const attempt = attemptAcquire(limit, { running: 1, tokens: null, refilledAt: null }, now);

    expect(attempt).toEqual({ granted: true, running: 2, tokens: null });
    expect(acquireResult(limit, attempt, now)).toEqual({ ok: true, holdsSlot: true });
  });

  it('retries after the concurrency delay when full', () => {
    const limit = { maxConcurrent: 1 };
    const attempt = attemptAcquire(limit, { running: 1, tokens: null, refilledAt: null }, now);

    expect(acquireResult(limit, attempt, now, 250)).toEqual({
      ok: false,
      retryAt: new Date(now.getTime() + 250),
    });
  });

  it('needs both a slot and a token, and waits for the longer of the two', () => {
    const limit = { maxConcurrent: 1, perSecond: 1 };
    const attempt = attemptAcquire(limit, { running: 1, tokens: 0, refilledAt: now }, now);

    expect(attempt.granted).toBe(false);
    expect(acquireResult(limit, attempt, now, 250)).toEqual({
      ok: false,
      retryAt: new Date(now.getTime() + 1_000),
    });
  });

  it('grants rate-only limits without holding a slot', () => {
    const limit = { perSecond: 1 };
    const attempt = attemptAcquire(limit, { running: 0, tokens: null, refilledAt: null }, now);

    expect(acquireResult(limit, attempt, now)).toEqual({ ok: true, holdsSlot: false });
  });
});
