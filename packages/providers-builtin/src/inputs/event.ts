import { defineInput, emptyPayload } from '@cloud-trigger/core';
import { z } from 'zod';

export const EventInputConfig = z.object({
  forwardHeaders: z
    .array(z.string().min(1))
    .default([])
    .describe('Inbound headers or message attributes to forward as payload attributes.'),
});

export const eventInput = defineInput({
  type: 'event',
  displayName: 'Inbound event',
  description: 'Forwards the body of the webhook request or queue message that started the run.',
  configSchema: EventInputConfig,
  resolve: (config, ctx) => {
    const event = ctx.trigger?.event;
    if (!event) {
      return Promise.resolve(emptyPayload);
    }
    const lower = Object.fromEntries(
      Object.entries(event.headers).map(([key, value]) => [key.toLowerCase(), value]),
    );

    return Promise.resolve({
      body: event.body,
      contentType: lower['content-type'],
      attributes: Object.fromEntries(
        config.forwardHeaders.flatMap((name) => {
          const value = lower[name.toLowerCase()];

          return value === undefined ? [] : [[name, value]];
        }),
      ),
    });
  },
});
