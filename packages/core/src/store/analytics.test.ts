import { describe, expect, it } from 'vitest';

import { statusCounts, statusCountsOf, summarizeRuns } from './analytics.js';

describe('summarizeRuns', () => {
  it('reports no rates or averages without runs', () => {
    expect(
      summarizeRuns({ total: 0, late: 0, byStatus: {}, avgMs: 12, p50Ms: null, p95Ms: null }),
    ).toEqual({
      total: 0,
      late: 0,
      byStatus: {},
      successRate: null,
      avgMs: null,
      p50Ms: null,
      p95Ms: null,
    });
  });

  it('counts timeouts as failures and ignores cancelled and skipped runs', () => {
    const summary = summarizeRuns({
      total: 10,
      late: 1,
      byStatus: { succeeded: 6, failed: 1, timed_out: 1, cancelled: 1, skipped: 1 },
      avgMs: 40,
      p50Ms: 30,
      p95Ms: 90,
    });

    expect(summary.successRate).toBe(0.75);
    expect(summary.avgMs).toBe(40);
  });
});

describe('status counts', () => {
  it('drops empty statuses', () => {
    expect(
      statusCounts([
        ['succeeded', 2],
        ['failed', 0],
      ]),
    ).toEqual({ succeeded: 2 });
  });

  it('reads known statuses from a row and ignores other fields', () => {
    expect(statusCountsOf({ _id: 'x', failed: 3, running: 0, p95: [1] })).toEqual({ failed: 3 });
  });
});
