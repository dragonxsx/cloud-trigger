import { describe, expect, it } from 'vitest';

import { TelemetryShape, telemetryPlan } from '../src/config/telemetry-config.js';

const plan = (env: Record<string, string> = {}) => telemetryPlan(TelemetryShape.parse(env));
const ENDPOINT = 'http://collector:4318';
const OFF = { otlp: undefined, console: false };

describe('telemetryPlan', () => {
  it('instruments but exports nothing without an OTLP endpoint', () => {
    expect(plan()).toEqual({
      instrument: true,
      traces: OFF,
      logs: OFF,
      metrics: OFF,
      quietInstrumentations: true,
    });
  });

  it('exports every signal to the generic endpoint', () => {
    expect(plan({ OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT })).toMatchObject({
      traces: { otlp: 'http/protobuf', console: false },
      logs: { otlp: 'http/protobuf', console: false },
      metrics: { otlp: 'http/protobuf', console: false },
    });
  });

  it('exports only the signals that have their own endpoint', () => {
    expect(plan({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${ENDPOINT}/v1/traces` })).toMatchObject({
      traces: { otlp: 'http/protobuf' },
      logs: OFF,
      metrics: OFF,
    });
  });

  it('honours none, console and the per-signal protocol', () => {
    expect(
      plan({
        OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT,
        OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
        OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'http/json',
        OTEL_LOGS_EXPORTER: 'none',
        OTEL_TRACES_EXPORTER: 'console',
        OTEL_METRICS_EXPORTER: 'otlp,console',
      }),
    ).toMatchObject({
      traces: { otlp: undefined, console: true },
      logs: OFF,
      metrics: { otlp: 'http/json', console: true },
    });
  });

  it('keeps console exporters but drops OTLP when no endpoint is set', () => {
    expect(
      plan({ OTEL_TRACES_EXPORTER: 'console,otlp', OTEL_LOGS_EXPORTER: 'otlp,console' }),
    ).toMatchObject({
      traces: { otlp: undefined, console: true },
      logs: { otlp: undefined, console: true },
    });
  });

  it('uses the per-signal protocol for traces and logs', () => {
    expect(
      plan({
        OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT,
        OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: 'grpc',
        OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
      }),
    ).toMatchObject({
      traces: { otlp: 'grpc' },
      logs: { otlp: 'http/json' },
      metrics: { otlp: 'http/protobuf' },
    });
  });

  it('turns everything off with OTEL_SDK_DISABLED', () => {
    expect(
      plan({ OTEL_SDK_DISABLED: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT }),
    ).toMatchObject({
      instrument: false,
      traces: OFF,
      logs: OFF,
      metrics: OFF,
    });
  });

  it('leaves instrumentation selection to the deployer once a list is set', () => {
    expect(plan({ OTEL_NODE_ENABLED_INSTRUMENTATIONS: 'http,undici' }).quietInstrumentations).toBe(
      false,
    );
  });

  it('rejects unknown exporters', () => {
    expect(TelemetryShape.safeParse({ OTEL_TRACES_EXPORTER: 'jaeger' }).success).toBe(false);
  });
});

describe('TelemetryShape', () => {
  it('treats empty variables as unset, as compose and Helm pass them', () => {
    const config = TelemetryShape.parse({
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
      OTEL_TRACES_EXPORTER: '',
      OTEL_SERVICE_NAME: '',
    });

    expect(config.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
    expect(config.OTEL_TRACES_EXPORTER).toEqual(['otlp']);
    expect(config.OTEL_SERVICE_NAME).toBeUndefined();
  });
});
