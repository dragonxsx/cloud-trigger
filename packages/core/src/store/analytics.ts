import { RunStatus } from '../domain/run.js';
import type { AnalyticsSummary } from '../ports/analytics.js';

export type StatusCounts = Partial<Record<RunStatus, number>>;

export const statusCounts = (pairs: Iterable<readonly [RunStatus, number]>): StatusCounts => {
  const counts: StatusCounts = {};
  for (const [status, count] of pairs) {
    if (count > 0) {
      counts[status] = count;
    }
  }

  return counts;
};

export const statusCountsOf = (row: Readonly<Record<string, unknown>>): StatusCounts =>
  statusCounts(
    RunStatus.options.flatMap((status) => {
      const value = row[status];

      return typeof value === 'number' ? [[status, value] as const] : [];
    }),
  );

export interface RunTotals {
  readonly total: number;
  readonly late: number;
  readonly byStatus: StatusCounts;
  readonly avgMs: number | null;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
}

export function summarizeRuns(totals: RunTotals): AnalyticsSummary {
  const succeeded = totals.byStatus.succeeded ?? 0;
  const failed = (totals.byStatus.failed ?? 0) + (totals.byStatus.timed_out ?? 0);

  return {
    total: totals.total,
    late: totals.late,
    byStatus: totals.byStatus,
    successRate: succeeded + failed === 0 ? null : succeeded / (succeeded + failed),
    avgMs: totals.total === 0 ? null : totals.avgMs,
    p50Ms: totals.p50Ms,
    p95Ms: totals.p95Ms,
  };
}
