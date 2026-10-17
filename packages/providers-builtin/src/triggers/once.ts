import { defineTrigger } from '@cloud-trigger/core';
import { z } from 'zod';

export const OnceConfig = z.object({
  at: z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
});

export const onceTrigger = defineTrigger({
  type: 'once',
  displayName: 'Once',
  description: 'Fires a single time at the given instant.',
  configSchema: OnceConfig,
  nextFireAt: (config, ctx) =>
    ctx.fireCount === 0 && config.at.getTime() > ctx.after.getTime() ? config.at : null,
  describe: (config) => `Once at ${config.at.toISOString()}`,
  lint: (config, { now }) =>
    config.at.getTime() <= now.getTime()
      ? [{ severity: 'warning', message: 'The fire time is in the past' }]
      : [],
});
