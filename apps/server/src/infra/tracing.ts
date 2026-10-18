import type { RunSpan, RunSpanAttributes, Tracer } from '@cloud-trigger/core';
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  type Tracer as OtelApiTracer,
  defaultTextMapGetter,
  defaultTextMapSetter,
  trace,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeSDK } from '@opentelemetry/sdk-node';

const propagator = new W3CTraceContextPropagator();

export class OtelRunTracer implements Tracer {
  constructor(private readonly tracer: OtelApiTracer) {}

  readonly startRun = (attributes: RunSpanAttributes): RunSpan => {
    const parent =
      attributes.parentTraceparent === undefined
        ? ROOT_CONTEXT
        : propagator.extract(
            ROOT_CONTEXT,
            { traceparent: attributes.parentTraceparent },
            defaultTextMapGetter,
          );
    const span = this.tracer.startSpan(
      `run ${attributes.jobName}`,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          'job.id': attributes.jobId,
          'job.name': attributes.jobName,
          'run.id': attributes.runId,
          'run.reason': attributes.reason,
          attempt: attributes.attempt,
        },
      },
      parent,
    );
    const carrier: Record<string, string> = {};
    propagator.inject(trace.setSpan(parent, span), carrier, defaultTextMapSetter);

    return {
      traceparent: carrier['traceparent'],
      end: ({ outcome, errorCode }) => {
        if (errorCode !== undefined) {
          span.setAttribute('error.code', errorCode);
        }
        span.setStatus(
          outcome === 'success'
            ? { code: SpanStatusCode.OK }
            : {
                code: SpanStatusCode.ERROR,
                ...(errorCode !== undefined && { message: errorCode }),
              },
        );
        span.end();
      },
    };
  };
}

export interface Tracing {
  readonly tracer: Tracer | undefined;
  readonly shutdown: () => Promise<void>;
}

export function startTracing(config: {
  readonly OTEL_EXPORTER_OTLP_ENDPOINT?: string | undefined;
  readonly OTEL_SERVICE_NAME: string;
}): Tracing {
  if (config.OTEL_EXPORTER_OTLP_ENDPOINT === undefined) {
    return { tracer: undefined, shutdown: () => Promise.resolve() };
  }
  const sdk = new NodeSDK({ serviceName: config.OTEL_SERVICE_NAME });
  sdk.start();

  return {
    tracer: new OtelRunTracer(trace.getTracer('cloud-trigger')),
    shutdown: () => sdk.shutdown(),
  };
}
