import { describe, expect, it } from 'vitest';

import { rruleTrigger } from './rrule.js';

const ctx = (after: string) => ({
  after: new Date(after),
  lastFiredAt: null,
  fireCount: 0,
  jobId: 'job',
});

const acceptsStart = (start: string) =>
  rruleTrigger.bind({ rule: 'FREQ=DAILY', start, timezone: 'UTC' }).isOk();

describe('rrule trigger', () => {
  it('fires on weekdays at 09:00 local time across a DST change', () => {
    const trigger = rruleTrigger
      .bind({
        rule: 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
        start: '2026-03-01T09:00',
        timezone: 'Europe/Berlin',
      })
      ._unsafeUnwrap();
    expect(trigger.nextFireAt(ctx('2026-03-26T12:00:00Z'))?.toISOString()).toBe(
      '2026-03-27T08:00:00.000Z',
    );
    expect(trigger.nextFireAt(ctx('2026-03-27T12:00:00Z'))?.toISOString()).toBe(
      '2026-03-30T07:00:00.000Z',
    );
    expect(trigger.describe()).toMatch(
      /^Every week on Monday, Wednesday, Friday.*\(Europe\/Berlin\)$/,
    );
  });

  it('moves a time that DST skips forward and always advances', () => {
    const trigger = rruleTrigger
      .bind({ rule: 'FREQ=DAILY', start: '2026-03-01T02:30', timezone: 'America/New_York' })
      ._unsafeUnwrap();
    for (const after of ['2026-03-08T06:00:00Z', '2026-03-08T06:30:00Z', '2026-03-08T07:00:00Z']) {
      expect(trigger.nextFireAt(ctx(after))?.toISOString()).toBe('2026-03-08T07:30:00.000Z');
    }
    expect(trigger.nextFireAt(ctx('2026-03-08T07:30:00Z'))?.toISOString()).toBe(
      '2026-03-09T06:30:00.000Z',
    );
  });

  it('fires once when DST repeats a wall time', () => {
    const trigger = rruleTrigger
      .bind({ rule: 'FREQ=DAILY', start: '2026-10-01T01:30', timezone: 'America/New_York' })
      ._unsafeUnwrap();
    const first = trigger.nextFireAt(ctx('2026-11-01T04:00:00Z'));
    expect(first?.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(trigger.nextFireAt(ctx('2026-11-01T05:30:00Z'))?.toISOString()).toBe(
      '2026-11-02T06:30:00.000Z',
    );
  });

  it('only accepts a wall-clock start', () => {
    expect(acceptsStart('2026-03-01T09:00')).toBe(true);
    expect(acceptsStart('2026-03-01T09:00:30.000')).toBe(true);
    expect(acceptsStart('2026-03-01T09:00:00.000Z')).toBe(false);
    expect(acceptsStart('2026-03-01T09:00+02:00')).toBe(false);
  });

  it('skips excluded dates such as holidays', () => {
    const trigger = rruleTrigger
      .bind({
        rule: 'FREQ=DAILY',
        start: '2026-12-20T06:30',
        timezone: 'UTC',
        exdates: ['2026-12-25', '2026-12-26'],
      })
      ._unsafeUnwrap();
    expect(trigger.nextFireAt(ctx('2026-12-24T07:00:00Z'))?.toISOString()).toBe(
      '2026-12-27T06:30:00.000Z',
    );
  });

  it('honours COUNT and rejects invalid rules', () => {
    const trigger = rruleTrigger
      .bind({ rule: 'FREQ=DAILY;COUNT=2', start: '2026-01-01T00:00', timezone: 'UTC' })
      ._unsafeUnwrap();
    expect(trigger.nextFireAt(ctx('2026-01-01T12:00:00Z'))?.toISOString()).toBe(
      '2026-01-02T00:00:00.000Z',
    );
    expect(trigger.nextFireAt(ctx('2026-01-02T12:00:00Z'))).toBeNull();
    expect(trigger.lint({ now: new Date('2026-06-01T00:00:00Z') })).toHaveLength(1);
    expect(rruleTrigger.bind({ rule: 'FREQ=SOMETIMES', start: '2026-01-01T00:00' }).isErr()).toBe(
      true,
    );
    expect(rruleTrigger.bind({ rule: 'BYDAY=MO', start: '2026-01-01T00:00' }).isErr()).toBe(true);
  });
});
