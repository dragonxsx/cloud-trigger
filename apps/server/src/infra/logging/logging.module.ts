import type { Logger } from '@cloud-trigger/core';
import { type DynamicModule, Global, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { Logger as Pino } from 'pino';

import { isQuietPath } from '../../common/quiet-paths.js';
import { injectionToken, token, valueProvider } from '../../common/tokens.js';
import { pinoLogger, redactRequestLog } from './logger.js';

export const LOGGER = token<Logger>('LOGGER');

@Global()
@Module({})
export class LoggingModule {
  static forRoot(pino: Pino): DynamicModule {
    return {
      module: LoggingModule,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: {
            logger: pino,
            serializers: { req: redactRequestLog },
            autoLogging: {
              ignore: (req) => isQuietPath(req.url),
            },
          },
        }),
      ],
      providers: [valueProvider(LOGGER, pinoLogger(pino))],
      exports: [injectionToken(LOGGER)],
    };
  }
}
