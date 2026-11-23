import { register } from 'node:module';

import { assertNever } from '@cloud-trigger/core';
import { metrics } from '@opentelemetry/api';
import {
  type InstrumentationConfigMap,
  getNodeAutoInstrumentations,
} from '@opentelemetry/auto-instrumentations-node';
import { OTLPLogExporter as GrpcLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { OTLPLogExporter as JsonLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPLogExporter as ProtoLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { OTLPMetricExporter as GrpcMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPMetricExporter as JsonMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPMetricExporter as ProtoMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter as GrpcTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPTraceExporter as JsonTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPTraceExporter as ProtoTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node';
import {
  type Resource,
  defaultResource,
  detectResources,
  envDetector,
  hostDetector,
  processDetector,
  resourceFromAttributes,
} from '@opentelemetry/resources';
import {
  BatchLogRecordProcessor,
  ConsoleLogRecordExporter,
  type LogRecordExporter,
  type LogRecordProcessor,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import {
  ConsoleMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace';
import { ATTR_SERVICE_INSTANCE_ID, ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { createAddHookMessageChannel } from 'import-in-the-middle';

import { isQuietPath } from '../../common/quiet-paths.js';
import {
  type OtlpProtocol,
  type SignalExport,
  type TelemetryConfig,
  type TelemetryPlan,
  exportsAnything,
  telemetryPlan,
} from '../../config/telemetry-config.js';

const MAX_EXPORT_TIMEOUT_MS = 30_000;
const DEFAULT_SERVICE_NAME = 'cloud-trigger';
const TRACEPARENT = 'traceparent';

export interface Telemetry {
  readonly meterProvider: MeterProvider;
  readonly prometheus: PrometheusExporter;
  readonly tracing: boolean;
  readonly shutdown: () => Promise<void>;
}

export const carriesTraceparent = (
  headers: string | readonly (string | readonly string[])[],
): boolean =>
  typeof headers === 'string'
    ? headers.split('\r\n').some((line) => line.toLowerCase().startsWith(`${TRACEPARENT}:`))
    : headers.some(
        (entry, index) =>
          index % 2 === 0 && typeof entry === 'string' && entry.toLowerCase() === TRACEPARENT,
      );

function otlpMetricExporter(protocol: OtlpProtocol): PushMetricExporter {
  switch (protocol) {
    case 'grpc':
      return new GrpcMetricExporter();
    case 'http/json':
      return new JsonMetricExporter();
    case 'http/protobuf':
      return new ProtoMetricExporter();
    default:
      return assertNever(protocol);
  }
}

function otlpSpanExporter(protocol: OtlpProtocol): SpanExporter {
  switch (protocol) {
    case 'grpc':
      return new GrpcTraceExporter();
    case 'http/json':
      return new JsonTraceExporter();
    case 'http/protobuf':
      return new ProtoTraceExporter();
    default:
      return assertNever(protocol);
  }
}

function otlpLogExporter(protocol: OtlpProtocol): LogRecordExporter {
  switch (protocol) {
    case 'grpc':
      return new GrpcLogExporter();
    case 'http/json':
      return new JsonLogExporter();
    case 'http/protobuf':
      return new ProtoLogExporter();
    default:
      return assertNever(protocol);
  }
}

const spanProcessors = (traces: SignalExport): SpanProcessor[] => [
  ...(traces.otlp === undefined
    ? []
    : [new BatchSpanProcessor({ exporter: otlpSpanExporter(traces.otlp) })]),
  ...(traces.console ? [new SimpleSpanProcessor({ exporter: new ConsoleSpanExporter() })] : []),
];

const logRecordProcessors = (logs: SignalExport): LogRecordProcessor[] => [
  ...(logs.otlp === undefined
    ? []
    : [new BatchLogRecordProcessor({ exporter: otlpLogExporter(logs.otlp) })]),
  ...(logs.console
    ? [new SimpleLogRecordProcessor({ exporter: new ConsoleLogRecordExporter() })]
    : []),
];

function pushReaders(exports: SignalExport, intervalMs: number): PeriodicExportingMetricReader[] {
  const exporters = [
    ...(exports.otlp === undefined ? [] : [otlpMetricExporter(exports.otlp)]),
    ...(exports.console ? [new ConsoleMetricExporter()] : []),
  ];

  return exporters.map(
    (exporter) =>
      new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: intervalMs,
        exportTimeoutMillis: Math.min(MAX_EXPORT_TIMEOUT_MS, intervalMs),
      }),
  );
}

export const serviceResource = (config: TelemetryConfig): Resource =>
  defaultResource()
    .merge(resourceFromAttributes({ [ATTR_SERVICE_NAME]: DEFAULT_SERVICE_NAME }))
    .merge(detectResources({ detectors: [envDetector, hostDetector, processDetector] }))
    .merge(resourceFromAttributes({ [ATTR_SERVICE_INSTANCE_ID]: config.INSTANCE_ID }));

function meterPipeline(
  config: TelemetryConfig,
  plan: TelemetryPlan,
  resource: Resource,
): Pick<Telemetry, 'meterProvider' | 'prometheus'> {
  const prometheus = new PrometheusExporter({
    preventServerStart: true,
    withoutScopeInfo: true,
    withoutTargetInfo: true,
  });
  const meterProvider = new MeterProvider({
    resource,
    readers: [prometheus, ...pushReaders(plan.metrics, config.OTEL_METRIC_EXPORT_INTERVAL)],
  });

  return { meterProvider, prometheus };
}

const instrumentations = (plan: TelemetryPlan) => {
  const configs: InstrumentationConfigMap = {
    '@opentelemetry/instrumentation-http': {
      ignoreIncomingRequestHook: (request) => isQuietPath(request.url),
    },
    '@opentelemetry/instrumentation-aws-sdk': { enabled: false },
    '@opentelemetry/instrumentation-grpc': { enabled: false },
    '@opentelemetry/instrumentation-pino': { disableLogSending: !exportsAnything(plan.logs) },
    '@opentelemetry/instrumentation-undici': {
      ignoreRequestHook: (request) => carriesTraceparent(request.headers),
    },
    ...(plan.quietInstrumentations && {
      '@opentelemetry/instrumentation-dns': { enabled: false },
      '@opentelemetry/instrumentation-net': { enabled: false },
    }),
  };

  return getNodeAutoInstrumentations(configs);
};

let started: Telemetry | undefined;

export const startedTelemetry = (): Telemetry | undefined => started;

export function metricsOnlyTelemetry(config: TelemetryConfig): Telemetry {
  const plan = telemetryPlan(config);
  const pipeline = meterPipeline(config, plan, serviceResource(config));
  const runtime = new RuntimeNodeInstrumentation();
  runtime.setMeterProvider(pipeline.meterProvider);

  return {
    ...pipeline,
    tracing: false,
    shutdown: async () => {
      runtime.disable();
      await pipeline.meterProvider.shutdown();
    },
  };
}

export async function startTelemetry(config: TelemetryConfig): Promise<Telemetry> {
  if (started !== undefined) {
    return started;
  }
  const plan = telemetryPlan(config);
  if (!plan.instrument) {
    started = metricsOnlyTelemetry(config);

    return started;
  }
  const resource = serviceResource(config);
  const pipeline = meterPipeline(config, plan, resource);
  metrics.setGlobalMeterProvider(pipeline.meterProvider);

  const { registerOptions, waitForAllMessagesAcknowledged } = createAddHookMessageChannel();
  register('import-in-the-middle/hook.mjs', import.meta.url, registerOptions);
  const sdk = new NodeSDK({
    resource,
    autoDetectResources: false,
    metricReaders: [],
    instrumentations: instrumentations(plan),
    spanProcessors: spanProcessors(plan.traces),
    logRecordProcessors: logRecordProcessors(plan.logs),
  });
  sdk.start();
  await waitForAllMessagesAcknowledged();

  started = {
    ...pipeline,
    tracing: exportsAnything(plan.traces),
    shutdown: async () => {
      await Promise.all([sdk.shutdown(), pipeline.meterProvider.shutdown()]);
    },
  };

  return started;
}
