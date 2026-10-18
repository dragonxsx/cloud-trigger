import type { Logger } from '@cloud-trigger/core';
import {
  type DestinationStream,
  type Logger as Pino,
  type LoggerOptions,
  pino as newPino,
} from 'pino';

// pino-http would log these verbatim.
export const REDACTED_LOG_PATHS = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
] as const;

export const createPino = (options: LoggerOptions, destination?: DestinationStream): Pino =>
  newPino({ ...options, redact: { paths: [...REDACTED_LOG_PATHS], censor: '***' } }, destination);

export const pinoLogger = (pino: Pino): Logger => ({
  debug: (message, context) => pino.debug(context ?? {}, message),
  info: (message, context) => pino.info(context ?? {}, message),
  warn: (message, context) => pino.warn(context ?? {}, message),
  error: (message, context) => pino.error(context ?? {}, message),
});
