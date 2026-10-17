import {
  type AnalyticsFilter,
  type AnalyticsSummary,
  type RunAnalytics,
  type RunMetric,
  RunStatus,
  type TimeBucket,
  type TimeseriesPoint,
  type TopError,
  JobId,
} from '@cloud-trigger/core';
import type { Collection, Db, Document } from 'mongodb';
import { z } from 'zod';

export interface RunMetricDocument {
  ts: Date;
  meta: { jobId: string; targetType: string };
  status: RunStatus;
  durationMs: number | null;
  statusCode: number | null;
  attempts: number;
  late: boolean;
  errorCode: string | null;
}

const STATUSES = RunStatus.options;
const nullableNumber = z.number().nullable().catch(null);
const percentiles = z.array(z.number().nullable()).nullable().catch(null);

const SummaryResult = z.object({
  overall: z.array(z.object({ total: z.number(), avg: nullableNumber, pct: percentiles })),
  byStatus: z.array(z.object({ _id: RunStatus, count: z.number() })),
});
const TimeseriesRow = z.object({
  _id: z.date(),
  p95: percentiles,
  ...Object.fromEntries(STATUSES.map((s) => [s, z.number()])),
});
const TopErrorRow = z.object({
  _id: z.object({ errorCode: z.string(), jobId: JobId }),
  count: z.number(),
});

const countByStatus = (row: Record<string, unknown>): Partial<Record<RunStatus, number>> =>
  Object.fromEntries(
    STATUSES.flatMap((s) => {
      const value = row[s];

      return typeof value === 'number' && value > 0 ? [[s, value]] : [];
    }),
  );

export class MongoRunAnalytics implements RunAnalytics {
  static readonly collectionName = 'run_metrics';

  constructor(private readonly metrics: Collection<RunMetricDocument>) {}

  static async ensureCollection(db: Db, ttlDays: number): Promise<void> {
    const exists = await db.listCollections({ name: MongoRunAnalytics.collectionName }).hasNext();
    if (!exists) {
      await db.createCollection(MongoRunAnalytics.collectionName, {
        timeseries: { timeField: 'ts', metaField: 'meta', granularity: 'minutes' },
        expireAfterSeconds: ttlDays * 86_400,
      });
    }
  }

  async record(metric: RunMetric): Promise<void> {
    await this.metrics.insertOne({
      ts: metric.ts,
      meta: { jobId: metric.jobId, targetType: metric.targetType },
      status: metric.status,
      durationMs: metric.durationMs,
      statusCode: metric.statusCode,
      attempts: metric.attempts,
      late: metric.late,
      errorCode: metric.errorCode,
    });
  }

  async summary(filter: AnalyticsFilter): Promise<AnalyticsSummary> {
    const [raw] = await this.metrics
      .aggregate([
        { $match: this.#match(filter) },
        {
          $facet: {
            overall: [
              {
                $group: {
                  _id: null,
                  total: { $sum: 1 },
                  avg: { $avg: '$durationMs' },
                  pct: {
                    $percentile: { input: '$durationMs', p: [0.5, 0.95], method: 'approximate' },
                  },
                },
              },
            ],
            byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
          },
        },
      ])
      .toArray();
    const result = SummaryResult.parse(raw);
    const byStatus = Object.fromEntries(result.byStatus.map((r) => [r._id, r.count]));
    const overall = result.overall[0];
    const ok = byStatus['succeeded'] ?? 0;
    const bad = (byStatus['failed'] ?? 0) + (byStatus['timed_out'] ?? 0);

    return {
      total: overall?.total ?? 0,
      byStatus,
      successRate: ok + bad === 0 ? null : ok / (ok + bad),
      avgMs: overall?.avg ?? null,
      p50Ms: overall?.pct?.[0] ?? null,
      p95Ms: overall?.pct?.[1] ?? null,
    };
  }

  async timeseries(
    filter: AnalyticsFilter & { bucket: TimeBucket },
  ): Promise<readonly TimeseriesPoint[]> {
    const statusCounters = Object.fromEntries(
      STATUSES.map((s) => [s, { $sum: { $cond: [{ $eq: ['$status', s] }, 1, 0] } }]),
    );
    const rows = await this.metrics
      .aggregate([
        { $match: this.#match(filter) },
        {
          $group: {
            _id: { $dateTrunc: { date: '$ts', unit: filter.bucket } },
            p95: { $percentile: { input: '$durationMs', p: [0.95], method: 'approximate' } },
            ...statusCounters,
          },
        },
        { $sort: { _id: 1 } },
      ])
      .toArray();

    return rows.map((raw) => {
      const row = TimeseriesRow.parse(raw);

      return { bucket: row._id, p95Ms: row.p95?.[0] ?? null, byStatus: countByStatus(row) };
    });
  }

  async topErrors(filter: AnalyticsFilter & { limit: number }): Promise<readonly TopError[]> {
    const rows = await this.metrics
      .aggregate([
        { $match: { ...this.#match(filter), errorCode: { $ne: null } } },
        { $group: { _id: { errorCode: '$errorCode', jobId: '$meta.jobId' }, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: filter.limit },
      ])
      .toArray();

    return rows.map((raw) => {
      const row = TopErrorRow.parse(raw);

      return { errorCode: row._id.errorCode, jobId: row._id.jobId, count: row.count };
    });
  }

  #match(filter: AnalyticsFilter): Document {
    return {
      ts: { $gte: filter.from, $lt: filter.to },
      ...(filter.jobId && { 'meta.jobId': filter.jobId }),
    };
  }
}
