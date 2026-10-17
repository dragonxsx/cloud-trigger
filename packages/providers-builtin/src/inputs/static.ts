import { assertNever, defineInput, emptyPayload } from '@cloud-trigger/core';
import { z } from 'zod';

export const StaticInputConfig = z.discriminatedUnion('format', [
  z.object({ format: z.literal('none') }).meta({ title: 'No payload' }),
  z.object({ format: z.literal('json'), value: z.json() }).meta({ title: 'JSON' }),
  z
    .object({
      format: z.literal('text'),
      value: z.string(),
      contentType: z.string().default('text/plain'),
    })
    .meta({ title: 'Text' }),
]);

export const staticInput = defineInput({
  type: 'static',
  displayName: 'Static',
  description: 'A fixed JSON or text payload (or none).',
  configSchema: StaticInputConfig,
  resolve: async (config) => {
    switch (config.format) {
      case 'none':
        return emptyPayload;
      case 'json':
        return {
          body: JSON.stringify(config.value),
          contentType: 'application/json',
          attributes: {},
        };
      case 'text':
        return { body: config.value, contentType: config.contentType, attributes: {} };
      default:
        return assertNever(config);
    }
  },
});
