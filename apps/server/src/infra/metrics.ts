import type { FinishedRun, Job, SkippedRun } from '@cloud-trigger/core';
import type { RunLifecycleListener } from '@cloud-trigger/engine';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from '@prometheus-io/client';

export class AppMetrics implements RunLifecycleListener {
  #activeRunsSource: () => number = () => 0;
  readonly registry = new Registry();
  readonly runsTotal = new Counter({
    name: 'cloud_trigger_runs_total',
    help: 'Terminal runs by status and target type',
    labelNames: ['status', 'target_type'] as const,
    registers: [this.registry],
  });
  readonly runDuration = new Histogram({
    name: 'cloud_trigger_run_duration_seconds',
    help: 'Duration of the final attempt',
    labelNames: ['status', 'target_type'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [this.registry],
  });
  readonly activeRuns = new Gauge({
    name: 'cloud_trigger_worker_active_runs',
    help: 'Runs currently executing on this instance',
    registers: [this.registry],
    collect: () => {
      this.activeRuns.set(this.#activeRunsSource());
    },
  });

  observeActiveRuns(source: () => number): void {
    this.#activeRunsSource = source;
  }

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  async onRunFinished(run: FinishedRun | SkippedRun, job: Job | undefined): Promise<void> {
    const labels = { status: run.status, target_type: job?.target.type ?? 'unknown' };
    this.runsTotal.inc(labels);
    const durationMs = run.status === 'skipped' ? undefined : run.result?.durationMs;
    if (durationMs !== undefined) {
      this.runDuration.observe(labels, durationMs / 1000);
    }
  }
}
