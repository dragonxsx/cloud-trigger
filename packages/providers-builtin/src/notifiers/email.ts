import {
  type NotifyResult,
  ResultAsync,
  defineInlineConnectedNotifier,
  err,
  ok,
} from '@cloud-trigger/core';
import { z } from 'zod';

import {
  SmtpConnectionConfig,
  type TransportFactory,
  createSmtpConnection,
  smtpSettings,
  smtpTransport,
  withTransport,
} from '../connections/smtp.js';
import { LiquidTemplate, renderWithSecrets } from '../shared/liquid.js';
import { DEFAULT_SUMMARY, eventScope, failure } from './event-scope.js';

export const EmailNotifierConfig = z.object({
  ...SmtpConnectionConfig.partial().shape,
  to: z.array(z.string().min(1)).min(1),
  subject: LiquidTemplate.default(DEFAULT_SUMMARY),
  body: LiquidTemplate.default(
    '{{ job.name }} {{ event }} at {{ occurredAt }}.\nRun: {{ run.id }} ({{ run.status }}, attempt {{ run.attempt }})',
  ).describe('Plain-text body. Variables: event, job.*, run.*, result, lateReasons.'),
});
export type EmailNotifierConfig = z.output<typeof EmailNotifierConfig>;

const SmtpError = z.object({ responseCode: z.number() });

const toFailure = (error: unknown) => {
  const smtp = SmtpError.safeParse(error);
  const message = error instanceof Error ? error.message : String(error);

  return failure(message, !smtp.success || smtp.data.responseCode < 500);
};

export const createEmailNotifier = (transportFor: TransportFactory = smtpTransport) =>
  defineInlineConnectedNotifier({
    type: 'email',
    displayName: 'Email',
    description: 'Sends a plain-text email over SMTP.',
    configSchema: EmailNotifierConfig,
    connection: createSmtpConnection(transportFor),
    async notify(config, event, ctx): Promise<NotifyResult> {
      const smtp = ctx.connection.config;
      const settings = await smtpSettings(smtp, ctx.secrets);
      if (settings.isErr()) {
        return err(failure(settings.error.message, false));
      }
      const scope = eventScope(event);
      const rendered = await ResultAsync.fromPromise(
        Promise.all([
          renderWithSecrets(config.subject, scope, ctx.secrets),
          renderWithSecrets(config.body, scope, ctx.secrets),
        ]),
        (error) => failure(error instanceof Error ? error.message : String(error), false),
      );
      if (rendered.isErr()) {
        return err(rendered.error);
      }
      const [subject, text] = rendered.value;
      const transport = transportFor(settings.value);
      const sent = await ResultAsync.fromPromise(
        withTransport(transport, ctx.signal, () =>
          transport.sendMail({
            from: smtp.from,
            to: config.to,
            subject,
            text,
            headers: { 'X-Idempotency-Key': event.idempotencyKey },
          }),
        ),
        toFailure,
      );

      return sent.isOk() ? ok(undefined) : err(sent.error);
    },
  });

export const emailNotifier = createEmailNotifier();
