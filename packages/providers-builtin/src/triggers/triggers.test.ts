import type { BoundTrigger } from '@cloud-trigger/core';
import { describe, expect, it } from 'vitest';

import { cronTrigger } from './cron.js';
import { expandHashTokens } from './hash-expression.js';
import { intervalTrigger } from './interval.js';
import { onceTrigger } from './once.js';

const ctx = (after: string, fireCount = 0) => ({
  after: new Date(after),
  lastFiredAt: null,
  fireCount,
  jobId: 'job-a',
});
const bind = (provider: typeof cronTrigger, config: unknown): BoundTrigger =>
  provider.bind(config)._unsafeUnwrap();

describe('cron trigger', () => {
  it('computes the next weekday 09:00 in the job time zone, skipping the weekend', () => {
    const t = bind(cronTrigger, { expression: '0 9 * * 1-5', timezone: 'Asia/Ho_Chi_Minh' });
    const fridayTenLocal = '2026-01-02T03:00:00Z';
    const mondayNineLocal = '2026-01-05T02:00:00.000Z';
    expect(t.nextFireAt(ctx(fridayTenLocal))?.toISOString()).toBe(mondayNineLocal);
    expect(t.describe()).toContain('Asia/Ho_Chi_Minh');
  });

  it('accepts ICU time zone aliases', () => {
    for (const timezone of ['Asia/Ho_Chi_Minh', 'Asia/Saigon']) {
      expect(cronTrigger.bind({ expression: '0 9 * * *', timezone }).isOk()).toBe(true);
    }
    expect(cronTrigger.bind({ expression: '0 9 * * *', timezone: 'Mars/Olympus' }).isErr()).toBe(
      true,
    );
  });

  it('supports last-day and nth-weekday syntax', () => {
    const last = bind(cronTrigger, { expression: '0 0 L * *' });
    expect(last.nextFireAt(ctx('2026-02-10T00:00:00Z'))?.toISOString()).toBe(
      '2026-02-28T00:00:00.000Z',
    );
    const secondFriday = bind(cronTrigger, { expression: '0 0 * * FRI#2' });
    expect(secondFriday.nextFireAt(ctx('2026-03-01T00:00:00Z'))?.toISOString()).toBe(
      '2026-03-13T00:00:00.000Z',
    );
  });

  it('respects bounds and maxCount', () => {
    const t = bind(cronTrigger, {
      expression: '0 * * * *',
      startAt: '2026-05-01T00:00:00Z',
      endAt: '2026-05-01T02:00:00Z',
      maxCount: 5,
    });
    expect(t.nextFireAt(ctx('2026-01-01T00:00:00Z'))?.toISOString()).toBe(
      '2026-05-01T00:00:00.000Z',
    );
    expect(t.nextFireAt(ctx('2026-05-01T02:00:00Z'))).toBeNull();
    expect(t.nextFireAt(ctx('2026-05-01T00:30:00Z', 5))).toBeNull();
  });

  it('expands H deterministically per job and rejects invalid expressions', () => {
    expect(expandHashTokens('H H * * *', 'job-a')).toBe(expandHashTokens('H H * * *', 'job-a'));
    expect(expandHashTokens('H/15 * * * *', 'x')).toMatch(/^\d{1,2}-59\/15 \* \* \* \*$/);
    expect(cronTrigger.bind({ expression: 'not a cron' }).isErr()).toBe(true);
    expect(
      bind(cronTrigger, { expression: '* * * * * *' }).lint({ now: new Date() })[0]?.severity,
    ).toBe('warning');
  });
});

describe('interval trigger', () => {
  it('aligns to startAt and offset', () => {
    const t = bind(intervalTrigger, {
      every: 15,
      unit: 'minutes',
      startAt: '2026-01-01T00:05:00Z',
    });
    expect(t.nextFireAt(ctx('2026-01-01T00:00:00Z'))?.toISOString()).toBe(
      '2026-01-01T00:05:00.000Z',
    );
    expect(t.nextFireAt(ctx('2026-01-01T00:05:00Z'))?.toISOString()).toBe(
      '2026-01-01T00:20:00.000Z',
    );
  });
});

describe('once trigger', () => {
  it('fires once in the future only', () => {
    const t = bind(onceTrigger, { at: '2030-01-01T00:00:00Z' });
    expect(t.nextFireAt(ctx('2026-01-01T00:00:00Z'))?.toISOString()).toBe(
      '2030-01-01T00:00:00.000Z',
    );
    expect(t.nextFireAt(ctx('2026-01-01T00:00:00Z', 1))).toBeNull();
  });
});
