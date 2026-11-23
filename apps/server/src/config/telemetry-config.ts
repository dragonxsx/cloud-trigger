import { hostname } from 'node:os';

import { z } from 'zod';

import { csv, splitCsv, unsetIfEmpty } from './env.js';

const OtlpProtocol = z.enum(['http/protobuf', 'http/json', 'grpc']);
export type OtlpProtocol = z.output<typeof OtlpProtocol>;

const exporters = <const T extends readonly [string, ...string[]]>(values: T, fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform(splitCsv)
    .pipe(z.array(z.enum(values)).min(1));

const SignalExporters = exporters(['otlp', 'console', 'none'], 'otlp');

export const TelemetryShape = z.object({
  INSTANCE_ID: unsetIfEmpty(
    z
      .string()
      .default(`${hostname()}-${process.pid}`)
      .describe(
        'Names this process in leases, logs and the service.instance.id resource attribute.',
      ),
  ),
  OTEL_SDK_DISABLED: unsetIfEmpty(
    z
      .stringbool()
      .default(false)
      .describe('Turns off OpenTelemetry instrumentation and export; /metrics keeps working.'),
  ),
  OTEL_SERVICE_NAME: unsetIfEmpty(
    z
      .string()
      .optional()
      .describe(
        'service.name resource attribute. Without it (or service.name in OTEL_RESOURCE_ATTRIBUTES), cloud-trigger.',
      ),
  ),
  OTEL_EXPORTER_OTLP_ENDPOINT: unsetIfEmpty(
    z
      .url()
      .optional()
      .describe(
        'OTLP collector base URL for every signal (e.g. http://otel-collector:4318). Nothing is exported over OTLP without an endpoint.',
      ),
  ),
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: unsetIfEmpty(
    z.url().optional().describe('Full OTLP URL for traces only.'),
  ),
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: unsetIfEmpty(
    z.url().optional().describe('Full OTLP URL for metrics only.'),
  ),
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: unsetIfEmpty(
    z.url().optional().describe('Full OTLP URL for logs only.'),
  ),
  OTEL_EXPORTER_OTLP_PROTOCOL: unsetIfEmpty(OtlpProtocol.default('http/protobuf')),
  OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: unsetIfEmpty(OtlpProtocol.optional()),
  OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: unsetIfEmpty(OtlpProtocol.optional()),
  OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: unsetIfEmpty(OtlpProtocol.optional()),
  OTEL_TRACES_EXPORTER: unsetIfEmpty(SignalExporters.describe('otlp, console or none.')),
  OTEL_METRICS_EXPORTER: unsetIfEmpty(
    exporters(['otlp', 'console', 'prometheus', 'none'], 'otlp').describe(
      'otlp, console or none. prometheus is accepted and changes nothing: /metrics is always served.',
    ),
  ),
  OTEL_LOGS_EXPORTER: unsetIfEmpty(SignalExporters.describe('otlp, console or none.')),
  OTEL_METRIC_EXPORT_INTERVAL: unsetIfEmpty(
    z.coerce
      .number()
      .int()
      .positive()
      .default(60_000)
      .describe('Milliseconds between OTLP metric pushes.'),
  ),
  OTEL_NODE_ENABLED_INSTRUMENTATIONS: unsetIfEmpty(
    csv.describe(
      'Only these auto-instrumentations, by short name (http,express,undici,mongodb,pino,...).',
    ),
  ),
  OTEL_NODE_DISABLED_INSTRUMENTATIONS: unsetIfEmpty(
    csv.describe(
      'Auto-instrumentations to turn off. Without either list, fs, dns and net are off.',
    ),
  ),
});
export type TelemetryConfig = z.output<typeof TelemetryShape>;

export interface SignalExport {
  readonly otlp: OtlpProtocol | undefined;
  readonly console: boolean;
}

export interface TelemetryPlan {
  readonly instrument: boolean;
  readonly traces: SignalExport;
  readonly logs: SignalExport;
  readonly metrics: SignalExport;
  readonly quietInstrumentations: boolean;
}

const OFF: SignalExport = { otlp: undefined, console: false };

export const exportsAnything = (signal: SignalExport): boolean =>
  signal.otlp !== undefined || signal.console;

const signalExport = (
  selected: readonly string[],
  endpoint: string | undefined,
  protocol: OtlpProtocol,
): SignalExport =>
  selected.includes('none')
    ? OFF
    : {
        otlp: selected.includes('otlp') && endpoint !== undefined ? protocol : undefined,
        console: selected.includes('console'),
      };

export function telemetryPlan(config: TelemetryConfig): TelemetryPlan {
  const generic = config.OTEL_EXPORTER_OTLP_ENDPOINT;
  const protocol = config.OTEL_EXPORTER_OTLP_PROTOCOL;
  const on = !config.OTEL_SDK_DISABLED;

  return {
    instrument: on,
    traces: on
      ? signalExport(
          config.OTEL_TRACES_EXPORTER,
          config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? generic,
          config.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? protocol,
        )
      : OFF,
    logs: on
      ? signalExport(
          config.OTEL_LOGS_EXPORTER,
          config.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? generic,
          config.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL ?? protocol,
        )
      : OFF,
    metrics: on
      ? signalExport(
          config.OTEL_METRICS_EXPORTER,
          config.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? generic,
          config.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL ?? protocol,
        )
      : OFF,
    quietInstrumentations:
      config.OTEL_NODE_ENABLED_INSTRUMENTATIONS.length === 0 &&
      config.OTEL_NODE_DISABLED_INSTRUMENTATIONS.length === 0,
  };
}
