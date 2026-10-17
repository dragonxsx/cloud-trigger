import type { JobId } from '../domain/ids.js';
import type { RunStatus } from '../domain/run.js';

export interface RunMetric {
  readonly ts: Date;
  readonly jobId: JobId;
  readonly status: RunStatus;
  readonly durationMs: number | null;
  readonly statusCode: number | null;
  readonly targetType: string;
  readonly attempts: number;
  readonly late: boolean;
  readonly errorCode: string | null;
}

export interface AnalyticsFilter {
  readonly from: Date;
  readonly to: Date;
  readonly jobId?: JobId | undefined;
}

export interface AnalyticsSummary {
  readonly total: number;
  readonly byStatus: Readonly<Partial<Record<RunStatus, number>>>;
  readonly successRate: number | null;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly avgMs: number | null;
}

export interface TimeseriesPoint {
  readonly bucket: Date;
  readonly byStatus: Readonly<Partial<Record<RunStatus, number>>>;
  readonly p95Ms: number | null;
}

export type TimeBucket = 'minute' | 'hour' | 'day';

export interface TopError {
  readonly errorCode: string;
  readonly count: number;
  readonly jobId: JobId;
}

export interface RunAnalytics {
  record(metric: RunMetric): Promise<void>;
  summary(filter: AnalyticsFilter): Promise<AnalyticsSummary>;
  timeseries(filter: AnalyticsFilter & { bucket: TimeBucket }): Promise<readonly TimeseriesPoint[]>;
  topErrors(filter: AnalyticsFilter & { limit: number }): Promise<readonly TopError[]>;
}
