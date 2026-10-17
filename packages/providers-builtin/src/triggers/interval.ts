import { defineTrigger } from '@cloud-trigger/core';
import { z } from 'zod';

import { TriggerBounds, nextWithinBounds } from './bounds.js';

const UNIT_MS = { seconds: 1_000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;

export const IntervalConfig = TriggerBounds.extend({
  every: z.int().positive(),
  unit: z.enum(['seconds', 'minutes', 'hours', 'days']).default('minutes'),
  offsetMs: z
    .int()
    .min(0)
    .default(0)
    .describe('Shifts the grid away from the epoch/startAt anchor, e.g. "every hour at :15".'),
});

export const intervalTrigger = defineTrigger({
  type: 'interval',
  displayName: 'Interval',
  description: 'Fires every N units, aligned to startAt (or the Unix epoch) plus an offset.',
  configSchema: IntervalConfig,
  nextFireAt: (config, ctx) =>
    nextWithinBounds(config, ctx, (after) => {
      const period = config.every * UNIT_MS[config.unit];
      const anchor = (config.startAt?.getTime() ?? 0) + config.offsetMs;
      const steps = Math.floor((after.getTime() - anchor) / period) + 1;

      return new Date(anchor + Math.max(0, steps) * period);
    }),
  describe: (config) =>
    `Every ${config.every} ${config.unit}${config.maxCount ? `, ${config.maxCount} times` : ''}`,
  lint: (config) =>
    config.every * UNIT_MS[config.unit] < 5_000
      ? [{ severity: 'warning', message: 'Intervals under 5 seconds may overload the target' }]
      : [],
});
