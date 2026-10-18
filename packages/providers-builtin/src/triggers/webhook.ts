import { createHash } from 'node:crypto';

import { type InboundVerdict, defineEventTrigger, secret } from '@cloud-trigger/core';
import { z } from 'zod';

import { interpolate } from '../shared/interpolate.js';
import { constantTimeEquals, verifySignature } from '../shared/signing.js';

export const WebhookTriggerConfig = z.object({
  token: secret(
    z
      .string()
      .refine(
        (token) => token.length >= 16 || /^\{\{\s*secret:[\w.-]+\s*\}\}$/.test(token),
        'Use at least 16 characters or a {{secret:NAME}} placeholder',
      ),
  ).describe(
    'Secret path segment of the webhook URL (at least 16 characters). May be {{secret:NAME}}.',
  ),
  idempotencyHeader: z
    .string()
    .min(1)
    .default('Idempotency-Key')
    .describe('Header that identifies a delivery; redeliveries with the same value run once.'),
  signing: z
    .object({
      secret: secret(z.string().min(1)),
      header: z.string().default('X-Signature'),
      timestampHeader: z.string().default('X-Signature-Timestamp'),
      toleranceSeconds: z.int().positive().default(300),
    })
    .optional()
    .describe('Require an HMAC-SHA256 "sha256=<hex>" signature over "<timestamp>.<body>".'),
  rateLimit: z
    .object({ perSecond: z.number().positive().max(10_000) })
    .optional()
    .describe('Deliveries above this rate are rejected with 429.'),
});
export type WebhookTriggerConfig = z.output<typeof WebhookTriggerConfig>;

const header = (headers: Readonly<Record<string, string>>, name: string): string | undefined =>
  headers[name.toLowerCase()];

const rejected = (reason: 'unauthorized' | 'invalid_signature'): InboundVerdict => ({
  accepted: false,
  reason,
});

export const webhookTrigger = defineEventTrigger({
  type: 'webhook',
  displayName: 'Inbound webhook',
  description:
    'Runs when POST /hooks/{jobId}/{token} is called. The request is available as {{ event }}.',
  configSchema: WebhookTriggerConfig,
  matches: (_config, event) => event.kind === 'webhook',
  upstream: () => [],
  describe: (config) =>
    `On webhook${config.signing ? ' (signed)' : ''}${config.rateLimit ? `, max ${config.rateLimit.perSecond}/s` : ''}`,
  async inbound(config, request, ctx) {
    const token = await interpolate(ctx.secrets, config.token);
    if (token.isErr() || !constantTimeEquals(token.value, request.token)) {
      return rejected('unauthorized');
    }
    const timestamp = config.signing
      ? header(request.headers, config.signing.timestampHeader)
      : undefined;
    if (config.signing) {
      const signingSecret = await interpolate(ctx.secrets, config.signing.secret);
      const valid =
        signingSecret.isOk() &&
        verifySignature({
          secret: signingSecret.value,
          signature: header(request.headers, config.signing.header),
          timestamp,
          body: request.body,
          now: ctx.now,
          toleranceSeconds: config.signing.toleranceSeconds,
        });
      if (!valid) {
        return rejected('invalid_signature');
      }
    }
    const deliveryId =
      header(request.headers, config.idempotencyHeader) ??
      createHash('sha256')
        .update(`${timestamp ?? request.receivedAt.toISOString()}.${request.body}`)
        .digest('hex');

    return { accepted: true, deliveryId, perSecond: config.rateLimit?.perSecond };
  },
});
