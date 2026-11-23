import type { Tracer } from '@cloud-trigger/core';
import { type DynamicModule, Global, Module } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';

import { ShutdownHook } from '../../common/shutdown-hook.js';
import { factoryProvider, injectionToken, token } from '../../common/tokens.js';
import { ConfigService } from '../../config/config.module.js';
import { MetricsController } from './metrics.controller.js';
import { AppMetrics } from './metrics.js';
import { type Telemetry, metricsOnlyTelemetry, startedTelemetry } from './sdk.js';
import { OtelRunTracer, type Tracing } from './tracing.js';

export const TELEMETRY = token<Telemetry>('TELEMETRY');
export const TRACING = token<Tracing>('TRACING');

export interface TelemetryOptions {
  readonly tracer?: Tracer | undefined;
}

const INSTRUMENTATION_SCOPE = 'cloud-trigger';

@Global()
@Module({})
export class TelemetryModule {
  static forRoot(options: TelemetryOptions = {}): DynamicModule {
    return {
      module: TelemetryModule,
      controllers: [MetricsController],
      providers: [
        factoryProvider(
          TELEMETRY,
          [ConfigService],
          ({ values }) => startedTelemetry() ?? metricsOnlyTelemetry(values),
        ),
        factoryProvider(
          token<ShutdownHook>('TELEMETRY_SHUTDOWN'),
          [TELEMETRY],
          (telemetry) => new ShutdownHook(telemetry.shutdown),
        ),
        factoryProvider(TRACING, [TELEMETRY], (telemetry) => ({
          tracer:
            options.tracer ??
            (telemetry.tracing
              ? new OtelRunTracer(trace.getTracer(INSTRUMENTATION_SCOPE))
              : undefined),
        })),
        factoryProvider(PrometheusExporter, [TELEMETRY], (telemetry) => telemetry.prometheus),
        factoryProvider(
          AppMetrics,
          [TELEMETRY],
          (telemetry) => new AppMetrics(telemetry.meterProvider.getMeter(INSTRUMENTATION_SCOPE)),
        ),
      ],
      exports: [injectionToken(TRACING), AppMetrics],
    };
  }
}
