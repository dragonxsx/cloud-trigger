import { randomUUID } from 'node:crypto';

import {
  type AnalyticsFilter,
  type AnalyticsSummary,
  JobId,
  type RunAnalytics,
  type RunMetric,
  RunStatus,
  type TimeBucket,
  type TimeseriesPoint,
  type TopError,
  statusCounts,
  summarizeRuns,
} from '@cloud-trigger/core';
import { type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { Epoch } from './codec.js';
import { and } from './query.js';
import { insertInto } from './rows.js';
import type { SqlSession } from './session.js';

const BUCKET_MS: Record<TimeBucket, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

const NullableNumber = z
  .union([z.number(), z.string()])
  .nullable()
  .transform((value) => (value === null ? null : Number(value)));

const OverallRow = z.object({ total: Epoch, late: NullableNumber, avg: NullableNumber });
const StatusRow = z.object({ status: RunStatus, count: Epoch });
const BucketRow = z.object({ bucket: Epoch, status: RunStatus, count: Epoch });
const ErrorRow = z.object({ error_code: z.string(), job_id: JobId, count: Epoch });

export class SqlRunAnalytics implements RunAnalytics {
  constructor(private readonly session: SqlSession) {}

  async record(metric: RunMetric): Promise<void> {
    await this.session.run(
      insertInto(this.session, 'run_metrics', {
        id: randomUUID(),
        ts: metric.ts,
        job_id: metric.jobId,
        target_type: metric.targetType,
        status: metric.status,
        duration_ms: metric.durationMs,
        status_code: metric.statusCode,
        attempts: metric.attempts,
        late: metric.late,
        error_code: metric.errorCode,
      }),
    );
  }

  #where(filter: AnalyticsFilter): SQL {
    return and([
      sql`ts >= ${filter.from.getTime()}`,
      sql`ts < ${filter.to.getTime()}`,
      filter.jobId ? sql`job_id = ${filter.jobId}` : undefined,
    ]);
  }

  async summary(filter: AnalyticsFilter): Promise<AnalyticsSummary> {
    const where = this.#where(filter);
    const [overall, statuses, percentiles] = await Promise.all([
      this.session.all(sql`
        SELECT count(*) AS total, sum(late) AS late, avg(duration_ms) AS avg
        FROM run_metrics WHERE ${where}`),
      this.session.all(
        sql`SELECT status, count(*) AS count FROM run_metrics WHERE ${where} GROUP BY status`,
      ),
      this.session.dialect.percentiles(this.session.exec, where, [0.5, 0.95]),
    ]);
    const totals = OverallRow.parse(overall[0]);

    return summarizeRuns({
      total: totals.total,
      late: totals.late ?? 0,
      byStatus: statusCounts(
        statuses.map((row) => {
          const parsed = StatusRow.parse(row);

          return [parsed.status, parsed.count] as const;
        }),
      ),
      avgMs: totals.avg,
      p50Ms: percentiles[0] ?? null,
      p95Ms: percentiles[1] ?? null,
    });
  }

  async timeseries(
    filter: AnalyticsFilter & { bucket: TimeBucket },
  ): Promise<readonly TimeseriesPoint[]> {
    const size = BUCKET_MS[filter.bucket];
    const where = this.#where(filter);
    const [rows, p95] = await Promise.all([
      this.session.all(sql`
        SELECT (ts / ${sql.raw(String(size))}) * ${sql.raw(String(size))} AS bucket, status,
          count(*) AS count
        FROM run_metrics WHERE ${where} GROUP BY bucket, status ORDER BY bucket`),
      this.session.dialect.bucketP95(this.session.exec, where, size),
    ]);
    const buckets = new Map<number, (readonly [RunStatus, number])[]>();
    for (const row of rows) {
      const parsed = BucketRow.parse(row);
      buckets.set(parsed.bucket, [
        ...(buckets.get(parsed.bucket) ?? []),
        [parsed.status, parsed.count],
      ]);
    }

    return [...buckets.entries()]
      .toSorted(([a], [b]) => a - b)
      .map(([bucket, counts]) => ({
        bucket: new Date(bucket),
        byStatus: statusCounts(counts),
        p95Ms: p95.get(bucket) ?? null,
      }));
  }

  async topErrors(filter: AnalyticsFilter & { limit: number }): Promise<readonly TopError[]> {
    const rows = await this.session.all(sql`
      SELECT error_code, job_id, count(*) AS count FROM run_metrics
      WHERE ${this.#where(filter)} AND error_code IS NOT NULL
      GROUP BY error_code, job_id ORDER BY count DESC LIMIT ${filter.limit}`);

    return rows.map((row) => {
      const parsed = ErrorRow.parse(row);

      return { errorCode: parsed.error_code, jobId: parsed.job_id, count: parsed.count };
    });
  }
}
