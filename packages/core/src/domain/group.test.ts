import { describe, expect, it } from 'vitest';

import { GroupSpec, RateLimit, resolvePolicy } from './group.js';
import { JobPolicy, effectivePolicy } from './policy.js';

const webhook = (url: string) => ({ type: 'webhook', config: { url } });

describe('effective policy', () => {
  it('uses system defaults without overrides', () => {
    expect(effectivePolicy({})).toEqual(JobPolicy.parse({}));
  });

  it('lets the job win and the group fill gaps, leaf by leaf', () => {
    const group = GroupSpec.parse({
      name: 'billing',
      defaultPolicy: { timeoutMs: 5_000, retry: { maxAttempts: 4, delayMs: 50 }, overlap: 'allow' },
    });
    const policy = effectivePolicy(
      { retry: { maxAttempts: 2 }, overlap: undefined },
      group.defaultPolicy,
    );
    expect(policy.timeoutMs).toBe(5_000);
    expect(policy.retry).toEqual({
      maxAttempts: 2,
      delayMs: 50,
      backoff: 'exponential',
      maxDelayMs: 300_000,
    });
    expect(policy.overlap).toBe('allow');
    expect(policy.misfire.mode).toBe('run_once');
  });

  it('prepends group notifications and exposes the rate limit', () => {
    const group = GroupSpec.parse({
      name: 'billing',
      defaultNotifications: [{ on: ['permanent_failure'], notifier: webhook('http://group') }],
      rateLimit: { maxConcurrent: 2 },
    });
    const resolved = resolvePolicy(
      { policy: {}, notifications: [{ on: ['success'], notifier: webhook('http://job') }] },
      group,
    );
    expect(resolved.notifications.map((n) => n.notifier.config)).toEqual([
      { url: 'http://group' },
      { url: 'http://job' },
    ]);
    expect(resolved.rateLimit).toEqual({ maxConcurrent: 2 });
    expect(resolvePolicy({ policy: {}, notifications: [] }, undefined).rateLimit).toBeNull();
  });

  it('requires at least one rate limit', () => {
    expect(RateLimit.safeParse({}).success).toBe(false);
  });
});
