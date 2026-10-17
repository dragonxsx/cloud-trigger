import { Result, type TriggerContext } from '@cloud-trigger/core';
import { z } from 'zod';

const isoDate = z.iso.datetime({ offset: true }).transform((s) => new Date(s));

export const TriggerBounds = z
  .object({
    startAt: isoDate.optional(),
    endAt: isoDate.optional(),
    maxCount: z.int().positive().optional(),
  })
  .describe('Optional limits shared by every scheduled trigger: start, end and a fire-count cap.');
export type TriggerBounds = z.output<typeof TriggerBounds>;

const formatterFor = Result.fromThrowable(
  (timeZone: string) => new Intl.DateTimeFormat('en-US', { timeZone }),
);

export const isTimeZone = (tz: string): boolean => formatterFor(tz).isOk();

export const TimeZone = z.string().default('UTC').refine(isTimeZone, 'Unknown IANA time zone');

export function nextWithinBounds(
  bounds: TriggerBounds,
  ctx: TriggerContext,
  computeAfter: (after: Date) => Date | null,
): Date | null {
  if (bounds.maxCount !== undefined && ctx.fireCount >= bounds.maxCount) {
    return null;
  }
  const after =
    bounds.startAt && bounds.startAt.getTime() > ctx.after.getTime()
      ? new Date(bounds.startAt.getTime() - 1)
      : ctx.after;
  const next = computeAfter(after);
  if (next === null) {
    return null;
  }
  if (bounds.endAt && next.getTime() > bounds.endAt.getTime()) {
    return null;
  }

  return next;
}
