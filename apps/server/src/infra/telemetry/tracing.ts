import type { RunSpan, RunSpanAttributes, Tracer } from '@cloud-trigger/core';
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  type Tracer as OtelApiTracer,
  defaultTextMapGetter,
  defaultTextMapSetter,
  trace,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

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
    const active = trace.setSpan(parent, span);
    const carrier: Record<string, string> = {};
    propagator.inject(active, carrier, defaultTextMapSetter);

    return {
      traceparent: carrier['traceparent'],
      activate: (work) => context.with(active, work),
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
}
