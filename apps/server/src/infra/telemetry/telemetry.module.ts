import type { Tracer } from '@cloud-trigger/core';
import { type DynamicModule, Global, Module } from '@nestjs/common';

import { ShutdownHook } from '../../common/shutdown-hook.js';
import { factoryProvider, injectionToken, token } from '../../common/tokens.js';
import { ConfigService } from '../../config/config.module.js';
import { MetricsController } from './metrics.controller.js';
import { AppMetrics } from './metrics.js';
import { type Tracing, startTracing } from './tracing.js';

export const TRACING = token<Tracing>('TRACING');

export interface TelemetryOptions {
  readonly tracer?: Tracer | undefined;
}

@Global()
@Module({})
export class TelemetryModule {
  static forRoot(options: TelemetryOptions = {}): DynamicModule {
    return {
      module: TelemetryModule,
      controllers: [MetricsController],
      providers: [
        factoryProvider(TRACING, [ConfigService], ({ values }) =>
          options.tracer
            ? { tracer: options.tracer, shutdown: () => Promise.resolve() }
            : startTracing(values),
        ),
        factoryProvider(
          token<ShutdownHook>('TRACING_SHUTDOWN'),
          [TRACING],
          (tracing) => new ShutdownHook(tracing.shutdown),
        ),
        factoryProvider(AppMetrics, [], () => new AppMetrics()),
      ],
      exports: [injectionToken(TRACING), AppMetrics],
    };
  }
}
