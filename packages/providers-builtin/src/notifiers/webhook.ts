import {
  type NotifyResult,
  defineNotifier,
  err,
  ok,
  okAsync,
  ResultAsync,
  secret,
  toError,
} from '@cloud-trigger/core';
import { request } from 'undici';
import { z } from 'zod';

import { interpolate, interpolateValues } from '../shared/interpolate.js';
import { SigningConfig, signatureHeaders } from '../shared/signing.js';
import { eventScope, failure, isRetryableStatus } from './event-scope.js';

export const WebhookNotifierConfig = z.object({
  url: z
    .string()
    .regex(/^https?:\/\//, 'Must start with http:// or https://')
    .describe('May contain {{secret:NAME}} placeholders.'),
  headers: z.record(z.string(), z.string()).default({}),
  secretHeaders: z
    .record(z.string(), secret(z.string()))
    .default({})
    .describe('Credential headers. Shown as *** and kept on edit.'),
  signing: SigningConfig.optional(),
});

export const webhookNotifier = defineNotifier({
  type: 'webhook',
  displayName: 'Webhook',
  description:
    'POSTs the run event as JSON. Sends an Idempotency-Key header so receivers can drop redeliveries.',
  configSchema: WebhookNotifierConfig,
  async notify(config, event, ctx): Promise<NotifyResult> {
    const resolved = await ResultAsync.combine([
      interpolate(ctx.secrets, config.url),
      interpolateValues(ctx.secrets, config.headers),
      interpolateValues(ctx.secrets, config.secretHeaders),
      config.signing ? interpolate(ctx.secrets, config.signing.secret) : okAsync(undefined),
    ] as const);
    if (resolved.isErr()) {
      return err(failure(resolved.error.message, false));
    }
    const [url, headers, secretHeaders, signingSecret] = resolved.value;
    const body = JSON.stringify(eventScope(event));
    const outgoing: Record<string, string> = {
      'user-agent': 'cloud-trigger',
      'content-type': 'application/json',
      'idempotency-key': event.idempotencyKey,
      ...headers,
      ...secretHeaders,
      ...(config.signing && signingSecret !== undefined
        ? signatureHeaders(config.signing, { secret: signingSecret, body, now: ctx.now })
        : {}),
    };
    const sent = await ResultAsync.fromPromise(
      request(url, { method: 'POST', headers: outgoing, body, signal: ctx.signal }),
      toError,
    );
    if (sent.isErr()) {
      return err(failure(sent.error.message, true));
    }
    await sent.value.body.dump();
    const status = sent.value.statusCode;

    return status >= 200 && status < 300
      ? ok(undefined)
      : err(failure(`Webhook responded ${status}`, isRetryableStatus(status)));
  },
});
