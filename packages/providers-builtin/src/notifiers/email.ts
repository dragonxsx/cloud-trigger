import {
  type NotifyResult,
  ResultAsync,
  defineNotifier,
  err,
  ok,
  secret,
} from '@cloud-trigger/core';
import { type SendMailOptions, createTransport } from 'nodemailer';
import { z } from 'zod';

import { interpolate } from '../shared/interpolate.js';
import { LiquidTemplate, renderWithSecrets } from '../shared/liquid.js';
import { DEFAULT_SUMMARY, eventScope, failure } from './event-scope.js';

export const EmailNotifierConfig = z.object({
  host: z.string().min(1),
  port: z.int().min(1).max(65_535).default(587),
  secure: z.boolean().default(false).describe('Use implicit TLS (usually port 465).'),
  user: secret(z.string()).optional().describe('SMTP user. May be {{secret:NAME}}.'),
  password: secret(z.string()).optional().describe('SMTP password. May be {{secret:NAME}}.'),
  from: z.string().min(1),
  to: z.array(z.string().min(1)).min(1),
  subject: LiquidTemplate.default(DEFAULT_SUMMARY),
  body: LiquidTemplate.default(
    '{{ job.name }} {{ event }} at {{ occurredAt }}.\nRun: {{ run.id }} ({{ run.status }}, attempt {{ run.attempt }})',
  ).describe('Plain-text body. Variables: event, job.*, run.*, result, lateReasons.'),
});
export type EmailNotifierConfig = z.output<typeof EmailNotifierConfig>;

export interface SmtpSettings {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly auth: { user: string; pass: string } | undefined;
}

export interface MailTransport {
  readonly sendMail: (mail: SendMailOptions) => Promise<unknown>;
  readonly close: () => void;
}

export type TransportFactory = (settings: SmtpSettings) => MailTransport;

const smtpTransport: TransportFactory = (settings) => {
  const transport = createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    ...(settings.auth && { auth: settings.auth }),
  });

  return { sendMail: (mail) => transport.sendMail(mail), close: () => transport.close() };
};

const SmtpError = z.object({ responseCode: z.number() });

const toFailure = (error: unknown) => {
  const smtp = SmtpError.safeParse(error);
  const message = error instanceof Error ? error.message : String(error);

  return failure(message, !smtp.success || smtp.data.responseCode < 500);
};

const resolveAuth = async (
  config: EmailNotifierConfig,
  secrets: Parameters<typeof interpolate>[0],
) => {
  if (config.user === undefined || config.password === undefined) {
    return ok(undefined);
  }
  const resolved = await ResultAsync.combine([
    interpolate(secrets, config.user),
    interpolate(secrets, config.password),
  ] as const);

  return resolved.map(([user, pass]) => ({ user, pass }));
};

export const createEmailNotifier = (transportFor: TransportFactory = smtpTransport) =>
  defineNotifier({
    type: 'email',
    displayName: 'Email',
    description: 'Sends a plain-text email over SMTP.',
    configSchema: EmailNotifierConfig,
    async notify(config, event, ctx): Promise<NotifyResult> {
      const auth = await resolveAuth(config, ctx.secrets);
      if (auth.isErr()) {
        return err(failure(auth.error.message, false));
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
      const transport = transportFor({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: auth.value,
      });
      const abort = () => transport.close();
      ctx.signal.addEventListener('abort', abort, { once: true });
      const sent = await ResultAsync.fromPromise(
        transport.sendMail({
          from: config.from,
          to: config.to,
          subject,
          text,
          headers: { 'X-Idempotency-Key': event.idempotencyKey },
        }),
        toFailure,
      );
      ctx.signal.removeEventListener('abort', abort);
      transport.close();

      return sent.isOk() ? ok(undefined) : err(sent.error);
    },
  });

export const emailNotifier = createEmailNotifier();
