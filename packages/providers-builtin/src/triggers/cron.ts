import { type LintIssue, Result, defineTrigger } from '@cloud-trigger/core';
import { Cron } from 'croner';
import cronstrue from 'cronstrue';
import { z } from 'zod';

import { TimeZone, TriggerBounds, nextWithinBounds } from './bounds.js';
import { expandHashTokens, hasHashToken } from './hash-expression.js';

const buildCron = (expression: string, timezone: string, seed: string): Cron =>
  new Cron(expandHashTokens(expression, seed), { timezone, paused: true, mode: '5-or-6-parts' });

const tryBuildCron = Result.fromThrowable(buildCron);
const isValidExpression = (expression: string): boolean =>
  tryBuildCron(expression, 'UTC', 'validation').isOk();

const utcOffsetLabel = (timeZone: string, at: Date): string =>
  new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value ?? '';

const januaryAndJulyOffsetsDiffer = (timeZone: string, year: number): boolean =>
  utcOffsetLabel(timeZone, new Date(Date.UTC(year, 0, 1))) !==
  utcOffsetLabel(timeZone, new Date(Date.UTC(year, 6, 1)));

export const CronConfig = TriggerBounds.extend({
  expression: z
    .string()
    .trim()
    .min(1)
    .refine(isValidExpression, 'Invalid cron expression')
    .describe(
      '5 or 6 fields (optional seconds first). Supports @hourly, L, #, and H for hash spreading.',
    ),
  timezone: TimeZone,
});

export const cronTrigger = defineTrigger({
  type: 'cron',
  displayName: 'Cron',
  description: 'Fires on a cron schedule in a given time zone.',
  configSchema: CronConfig,
  nextFireAt: (config, ctx) =>
    nextWithinBounds(config, ctx, (after) =>
      buildCron(config.expression, config.timezone, ctx.jobId).nextRun(after),
    ),
  describe: (config) => {
    const human = hasHashToken(config.expression)
      ? `Cron "${config.expression}" (hash-spread per job)`
      : cronstrue.toString(config.expression, {
          use24HourTimeFormat: true,
          throwExceptionOnParseError: false,
        });

    return `${human} (${config.timezone})`;
  },
  lint: (config, { now }) => {
    const issues: LintIssue[] = [];
    const runs = buildCron(config.expression, config.timezone, 'lint').nextRuns(3);
    const [first, second] = runs;
    if (!first) {
      issues.push({ severity: 'error', message: 'Expression never fires' });
    } else if (second && second.getTime() - first.getTime() < 60_000) {
      issues.push({ severity: 'warning', message: 'Fires more than once per minute' });
    }
    const hourField = config.expression.trim().split(/\s+/).at(-4) ?? '';
    const touchesDstWindow =
      hourField === '*' || hourField.split(/[,\-/]/).some((v) => /^\d+$/.test(v) && Number(v) <= 3);
    if (touchesDstWindow && januaryAndJulyOffsetsDiffer(config.timezone, now.getUTCFullYear())) {
      issues.push({
        severity: 'info',
        message: 'Runs between 00:00 and 03:59 local time may shift on DST changes',
      });
    }

    return issues;
  },
});
