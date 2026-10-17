import type { FinishedRun, Job, RunAnalytics, SkippedRun } from '@cloud-trigger/core';

import type { RunLifecycleListener } from './lifecycle.js';

export class AnalyticsListener implements RunLifecycleListener {
  constructor(private readonly analytics: RunAnalytics) {}

  async onRunFinished(run: FinishedRun | SkippedRun, job: Job | undefined): Promise<void> {
    const result = run.status === 'skipped' ? null : run.result;
    await this.analytics.record({
      ts: run.finishedAt,
      jobId: run.jobId,
      status: run.status,
      durationMs: result?.durationMs ?? null,
      statusCode: result?.statusCode ?? null,
      targetType: job?.target.type ?? 'unknown',
      attempts: run.attempts.length,
      late: run.late,
      errorCode: result?.error?.code ?? null,
    });
  }
}
