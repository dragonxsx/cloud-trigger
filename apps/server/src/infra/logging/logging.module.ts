import type { Logger } from '@cloud-trigger/core';
import { type DynamicModule, Global, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { Logger as Pino } from 'pino';

import { injectionToken, token, valueProvider } from '../../common/tokens.js';
import { pinoLogger } from './logger.js';

export const LOGGER = token<Logger>('LOGGER');

const QUIET_PATHS = ['/health', '/metrics'];

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
            autoLogging: {
              ignore: (req) => QUIET_PATHS.some((p) => req.url?.startsWith(p) === true),
            },
          },
        }),
      ],
      providers: [valueProvider(LOGGER, pinoLogger(pino))],
      exports: [injectionToken(LOGGER)],
    };
  }
}
