import type { SpanProcessor } from '@opentelemetry/sdk-trace';
import { ATTR_URL_FULL, ATTR_URL_PATH } from '@opentelemetry/semantic-conventions';

import { redactWebhookToken, webhookTokenForms } from '../../common/webhook-paths.js';

const URL_ATTRIBUTES = [ATTR_URL_PATH, ATTR_URL_FULL] as const;

export const webhookRedactingSpanProcessor = (): SpanProcessor => ({
  onStart: (span) => {
    for (const key of URL_ATTRIBUTES) {
      const value = span.attributes[key];
      if (typeof value === 'string' && webhookTokenForms(value).length > 0) {
        span.setAttribute(key, redactWebhookToken(value));
      }
    }
  },
  onEnd: () => undefined,
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
});
