import {
  type NotifyResult,
  ResultAsync,
  defineConnectedNotifier,
  err,
  ok,
  okAsync,
  secret,
  toError,
} from '@cloud-trigger/core';
import { request } from 'undici';
import { z } from 'zod';

import { httpConnection, prepareRequest, urlIssues } from '../connections/http.js';
import { interpolate, interpolateValues } from '../shared/interpolate.js';
import { SigningConfig, signatureHeaders } from '../shared/signing.js';
import { eventScope, failure, isRetryableStatus } from './event-scope.js';

export const WebhookNotifierConfig = z.object({
  url: z
    .string()
    .describe(
      'Absolute http(s) URL, or a path relative to the base URL when the notifier uses a connection. May contain {{secret:NAME}} placeholders.',
    ),
  headers: z
    .record(z.string(), z.string())
    .default({})
    .describe('Override connection headers of the same name.'),
  secretHeaders: z
    .record(z.string(), secret(z.string()))
    .default({})
    .describe('Credential headers. Shown as *** and kept on edit.'),
  signing: SigningConfig.optional().describe('Overrides the connection signing when set.'),
});

export const webhookNotifier = defineConnectedNotifier({
  type: 'webhook',
  displayName: 'Webhook',
  description:
    'POSTs the run event as JSON. Sends an Idempotency-Key header so receivers can drop redeliveries.',
  configSchema: WebhookNotifierConfig,
  connection: httpConnection,
  check: (config, connection) => urlIssues(config.url, connection),
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
    const [rawUrl, headers, secretHeaders, signingSecret] = resolved.value;
    const prepared = await prepareRequest(rawUrl, {}, ctx.connection, ctx.secrets, {
      now: ctx.now,
      signal: ctx.signal,
    });
    if (prepared.isErr()) {
      return err(failure(prepared.error.message, prepared.error.retryable));
    }
    const { url } = prepared.value;
    const signing =
      config.signing && signingSecret !== undefined
        ? { config: config.signing, secret: signingSecret }
        : prepared.value.connection?.signing;
    const body = JSON.stringify(eventScope(event));
    const outgoing: Record<string, string> = {
      'user-agent': 'cloud-trigger',
      'content-type': 'application/json',
      'idempotency-key': event.idempotencyKey,
      ...prepared.value.connection?.headers,
      ...headers,
      ...secretHeaders,
      ...(signing &&
        signatureHeaders(signing.config, { secret: signing.secret, body, now: ctx.now })),
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
