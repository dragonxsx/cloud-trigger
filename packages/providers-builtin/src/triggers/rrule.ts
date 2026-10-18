import { Result, defineTrigger } from '@cloud-trigger/core';
import * as rruleModule from 'rrule';
import { z } from 'zod';

import { TimeZone, TriggerBounds, nextWithinBounds } from './bounds.js';
import { fromWallClock, toWallClock, utcOffsetMs } from './wall-clock.js';

type RRuleClass = typeof rruleModule.RRule;
type RRule = InstanceType<RRuleClass>;

const loadRRule = (ns: {
  readonly RRule?: RRuleClass;
  readonly default?: { readonly RRule: RRuleClass };
}): RRuleClass => {
  const rrule = ns.RRule ?? ns.default?.RRule;
  if (!rrule) {
    throw new Error('The rrule package did not load');
  }

  return rrule;
};

const RRule = loadRRule(rruleModule);

const MAX_SKIPPED = 1_000;
const MAX_DST_SHIFT_MS = 3 * 3_600_000;
const ZONELESS_WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

const stripPrefix = (rule: string) => rule.trim().replace(/^RRULE:/i, '');
const parseRule = Result.fromThrowable((rule: string) => RRule.parseString(stripPrefix(rule)));
const isValidRule = (rule: string): boolean =>
  parseRule(rule).match(
    (options) => options.freq !== undefined && options.dtstart === undefined,
    () => false,
  );

export const RruleConfig = TriggerBounds.extend({
  rule: z
    .string()
    .min(1)
    .refine(isValidRule, 'Not an RFC 5545 RRULE, e.g. FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=9')
    .describe('RFC 5545 recurrence rule, e.g. FREQ=MONTHLY;BYDAY=-1FR (last Friday of the month).'),
  start: z
    .string()
    .regex(ZONELESS_WALL_CLOCK, 'Use a wall-clock time without a zone, e.g. 2026-03-01T09:00')
    .meta({
      widget: 'wall-clock',
      description:
        'First occurrence, as wall-clock time in the time zone. Also sets the default time of day.',
    }),
  timezone: TimeZone,
  exdates: z
    .array(z.iso.date())
    .default([])
    .describe('Dates (YYYY-MM-DD, in the time zone) to skip, such as public holidays.'),
});
export type RruleConfig = z.output<typeof RruleConfig>;

const ruleOf = (config: RruleConfig): RRule =>
  new RRule({
    ...parseRule(config.rule).unwrapOr({}),
    dtstart: new Date(`${config.start.length === 16 ? `${config.start}:00` : config.start}Z`),
  });

const nextOccurrence = (config: RruleConfig, after: Date): Date | null => {
  const rule = ruleOf(config);
  const excluded = new Set(config.exdates);
  const springForwardGapMs = Math.max(
    0,
    utcOffsetMs(after, config.timezone) -
      utcOffsetMs(new Date(after.getTime() - MAX_DST_SHIFT_MS), config.timezone),
  );
  const from = new Date(toWallClock(after, config.timezone).getTime() - springForwardGapMs);
  let skipped = 0;
  for (
    let candidate = rule.after(from, false);
    candidate;
    candidate = rule.after(candidate, false)
  ) {
    if (excluded.has(candidate.toISOString().slice(0, 10))) {
      if (++skipped >= MAX_SKIPPED) {
        return null;
      }
      continue;
    }
    const instant = fromWallClock(candidate, config.timezone);
    if (instant.getTime() > after.getTime()) {
      return instant;
    }
  }

  return null;
};

export const rruleTrigger = defineTrigger({
  type: 'rrule',
  displayName: 'Calendar rule (RRULE)',
  description: 'Fires on an RFC 5545 recurrence rule, with excluded dates for holidays.',
  configSchema: RruleConfig,
  nextFireAt: (config, ctx) =>
    nextWithinBounds(config, ctx, (after) => nextOccurrence(config, after)),
  describe: (config) => {
    const text = ruleOf(config).toText();
    const skips = config.exdates.length > 0 ? `, skipping ${config.exdates.length} date(s)` : '';

    return `${text.charAt(0).toUpperCase()}${text.slice(1)}${skips} (${config.timezone})`;
  },
  lint: (config, { now }) =>
    nextOccurrence(config, now) === null
      ? [{ severity: 'warning', message: 'This rule has no future occurrences' }]
      : [],
});
