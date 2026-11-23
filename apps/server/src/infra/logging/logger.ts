import type { Logger } from '@cloud-trigger/core';
import {
  type DestinationStream,
  type Logger as Pino,
  type LoggerOptions,
  pino as newPino,
} from 'pino';
import { z } from 'zod';

import {
  REDACTED_TOKEN,
  redactWebhookToken,
  webhookTokenForms,
} from '../../common/webhook-paths.js';

// pino-http would log these verbatim.
export const REDACTED_LOG_PATHS = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
] as const;

const LoggedRequest = z.looseObject({ url: z.string() });
const RouteParams = z.record(z.string(), z.unknown());
const ParamValue = z.union([z.string(), z.array(z.string())]);

const maskParam = (tokens: readonly string[]) => {
  const mask = (part: string) => (tokens.includes(part) ? REDACTED_TOKEN : part);

  return (value: unknown): unknown => {
    const parsed = ParamValue.safeParse(value);
    if (!parsed.success) {
      return value;
    }

    return typeof parsed.data === 'string' ? mask(parsed.data) : parsed.data.map(mask);
  };
};

export const redactRequestLog = (req: unknown): unknown => {
  const parsed = LoggedRequest.safeParse(req);
  if (!parsed.success) {
    return req;
  }
  const tokens = webhookTokenForms(parsed.data.url);
  if (tokens.length === 0) {
    return req;
  }
  const params = RouteParams.safeParse(parsed.data['params']);

  return {
    ...parsed.data,
    url: redactWebhookToken(parsed.data.url),
    ...(params.success && {
      params: Object.fromEntries(
        Object.entries(params.data).map(([key, value]) => [key, maskParam(tokens)(value)]),
      ),
    }),
  };
};

export const createPino = (options: LoggerOptions, destination?: DestinationStream): Pino =>
  newPino({ ...options, redact: { paths: [...REDACTED_LOG_PATHS], censor: '***' } }, destination);

export const pinoLogger = (pino: Pino): Logger => ({
  debug: (message, context) => pino.debug(context ?? {}, message),
  info: (message, context) => pino.info(context ?? {}, message),
  warn: (message, context) => pino.warn(context ?? {}, message),
  error: (message, context) => pino.error(context ?? {}, message),
});
