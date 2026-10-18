import {
  type NotifyResult,
  ResultAsync,
  defineNotifier,
  err,
  ok,
  secret,
} from '@cloud-trigger/core';
import { IncomingWebhook, IncomingWebhookHTTPError } from '@slack/webhook';
import { z } from 'zod';

import { interpolate } from '../shared/interpolate.js';
import { LiquidTemplate, renderWithSecrets } from '../shared/liquid.js';
import { DEFAULT_SUMMARY, eventScope, failure, isRetryableStatus } from './event-scope.js';

export const SlackNotifierConfig = z.object({
  url: secret(z.string().min(1)).describe(
    'Slack incoming-webhook URL. Shown as *** and kept on edit. May be {{secret:NAME}}.',
  ),
  template: LiquidTemplate.default(DEFAULT_SUMMARY).describe(
    'Liquid template for the message text. Variables: event, job.*, run.*, result, lateReasons.',
  ),
  channel: z.string().optional(),
  username: z.string().optional(),
});

const toFailure = (error: unknown) =>
  error instanceof IncomingWebhookHTTPError
    ? failure(`Slack responded ${error.statusCode}`, isRetryableStatus(error.statusCode))
    : failure(error instanceof Error ? error.message : String(error), true);

export const slackNotifier = defineNotifier({
  type: 'slack',
  displayName: 'Slack',
  description: 'Posts a message to a Slack incoming webhook.',
  configSchema: SlackNotifierConfig,
  async notify(config, event, ctx): Promise<NotifyResult> {
    const url = await interpolate(ctx.secrets, config.url);
    if (url.isErr()) {
      return err(failure(url.error.message, false));
    }
    const text = await ResultAsync.fromPromise(
      renderWithSecrets(config.template, eventScope(event), ctx.secrets),
      (error) => failure(error instanceof Error ? error.message : String(error), false),
    );
    if (text.isErr()) {
      return err(text.error);
    }
    const webhook = new IncomingWebhook(url.value, {
      fetch: (target, init) => fetch(target, { ...init, signal: ctx.signal }),
    });
    const sent = await ResultAsync.fromPromise(
      webhook.send({
        text: text.value,
        ...(config.channel !== undefined && { channel: config.channel }),
        ...(config.username !== undefined && { username: config.username }),
      }),
      toFailure,
    );

    return sent.isOk() ? ok(undefined) : err(sent.error);
  },
});
