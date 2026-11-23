export interface RunSpanAttributes {
  readonly jobId: string;
  readonly jobName: string;
  readonly runId: string;
  readonly attempt: number;
  readonly reason: string;
  readonly parentTraceparent?: string | undefined;
}

export interface RunSpanOutcome {
  readonly outcome: 'success' | 'failure';
  readonly errorCode?: string | undefined;
}

export interface RunSpan {
  readonly traceparent: string | undefined;
  readonly activate: <T>(work: () => Promise<T>) => Promise<T>;
  readonly end: (outcome: RunSpanOutcome) => void;
}

export interface Tracer {
  readonly startRun: (attributes: RunSpanAttributes) => RunSpan;
}

export const noopTracer: Tracer = {
  startRun: () => ({ traceparent: undefined, activate: (work) => work(), end: () => undefined }),
};
