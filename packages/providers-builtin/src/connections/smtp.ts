import {
  type ConnectionTestResult,
  type SecretResolver,
  ResultAsync,
  defineConnection,
  err,
  ok,
  okAsync,
  secret,
  toError,
} from '@cloud-trigger/core';
import { type SendMailOptions, createTransport } from 'nodemailer';
import { z } from 'zod';

import { interpolate } from '../shared/interpolate.js';

export const SmtpConnectionConfig = z.object({
  host: z.string().min(1),
  port: z.int().min(1).max(65_535).default(587),
  secure: z.boolean().default(false).describe('Use implicit TLS (usually port 465).'),
  user: secret(z.string()).optional().describe('SMTP user. May be {{secret:NAME}}.'),
  password: secret(z.string()).optional().describe('SMTP password. May be {{secret:NAME}}.'),
  from: z.string().min(1).describe('Sender address, such as "Cloud Trigger <ct@example.com>".'),
});
export type SmtpConnectionConfig = z.output<typeof SmtpConnectionConfig>;

export interface SmtpSettings {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly auth: { user: string; pass: string } | undefined;
}

export interface MailTransport {
  readonly sendMail: (mail: SendMailOptions) => Promise<unknown>;
  readonly verify: () => Promise<unknown>;
  readonly close: () => void;
}

export type TransportFactory = (settings: SmtpSettings) => MailTransport;

// Nodemailer can't cancel a connection in flight, so these bound how long an abandoned one lingers.
const CONNECT_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 30_000;

export const smtpTransport: TransportFactory = (settings) => {
  const transport = createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    ...(settings.auth && { auth: settings.auth }),
  });

  return {
    sendMail: (mail) => transport.sendMail(mail),
    verify: () => transport.verify(),
    close: () => transport.close(),
  };
};

export const smtpSettings = (
  config: SmtpConnectionConfig,
  secrets: SecretResolver,
): ResultAsync<SmtpSettings, { readonly message: string }> => {
  const auth =
    config.user === undefined || config.password === undefined
      ? okAsync(undefined)
      : ResultAsync.combine([
          interpolate(secrets, config.user),
          interpolate(secrets, config.password),
        ] as const).map(([user, pass]) => ({ user, pass }));

  return auth.map((resolved) => ({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: resolved,
  }));
};

export const withTransport = async <T>(
  transport: MailTransport,
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T> => {
  const aborted = Promise.withResolvers<never>();
  const abort = () => aborted.reject(toError(signal.reason));
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();

    return await Promise.race([work(), aborted.promise]);
  } finally {
    signal.removeEventListener('abort', abort);
    transport.close();
  }
};

export const createSmtpConnection = (transportFor: TransportFactory = smtpTransport) =>
  defineConnection({
    type: 'smtp',
    displayName: 'SMTP server',
    description: 'A mail server and sender address that email notifications go out through.',
    configSchema: SmtpConnectionConfig,
    async test(config, { secrets, signal }): Promise<ConnectionTestResult> {
      const settings = await smtpSettings(config, secrets);
      if (settings.isErr()) {
        return err({ message: settings.error.message });
      }
      const transport = transportFor(settings.value);
      const verified = await ResultAsync.fromPromise(
        withTransport(transport, signal, () => transport.verify()),
        toError,
      );

      return verified.isOk()
        ? ok({ message: `${config.host}:${config.port} accepted the connection` })
        : err({ message: verified.error.message });
    },
  });

export const smtpConnection = createSmtpConnection();
