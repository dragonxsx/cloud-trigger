import {
  type EngineMetrics,
  type EngineSignal,
  type FinishedRun,
  type Job,
  type PendingRun,
  type RunningRun,
  type SkippedRun,
  assertNever,
} from '@cloud-trigger/core';
import type { RunLifecycleListener } from '@cloud-trigger/engine';
import type { Counter, Histogram, Meter } from '@opentelemetry/api';

const RUN_DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];
const START_LAG_BUCKETS = [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 900];
const MS_PER_SECOND = 1000;

export class AppMetrics implements RunLifecycleListener, EngineMetrics {
  #activeRunsSource: () => number = () => 0;
  readonly #runs: Counter;
  readonly #runDuration: Histogram;
  readonly #late: Counter;
  readonly #fires: Counter;
  readonly #firesDropped: Counter;
  readonly #decisions: Counter;
  readonly #startLag: Histogram;
  readonly #leaseExpirations: Counter;
  readonly #staleCommits: Counter;

  constructor(meter: Meter) {
    this.#runs = meter.createCounter('cloud_trigger_runs', {
      description: 'Terminal runs by status and target type',
    });
    this.#runDuration = meter.createHistogram('cloud_trigger_run_duration_seconds', {
      description: 'Duration of the final attempt',
      unit: 's',
      advice: { explicitBucketBoundaries: RUN_DURATION_BUCKETS },
    });
    this.#late = meter.createCounter('cloud_trigger_runs_late', {
      description: 'Runs flagged late by the SLA monitor, by job name',
    });
    this.#fires = meter.createCounter('cloud_trigger_fires', {
      description: 'Runs queued by the scheduler, by reason (scheduled or catchup)',
    });
    this.#firesDropped = meter.createCounter('cloud_trigger_fires_dropped', {
      description: 'Fires dropped because another scheduler took over the job claim',
    });
    this.#decisions = meter.createCounter('cloud_trigger_schedule_decisions', {
      description: 'Non-routine scheduling decisions (skips, catch-ups, pauses, throttling)',
    });
    this.#startLag = meter.createHistogram('cloud_trigger_run_start_lag_seconds', {
      description: 'Delay between the scheduled time and the start of the first attempt',
      unit: 's',
      advice: { explicitBucketBoundaries: START_LAG_BUCKETS },
    });
    this.#leaseExpirations = meter.createCounter('cloud_trigger_lease_expirations', {
      description: 'Running runs recovered by the reaper after their worker lease expired',
    });
    this.#staleCommits = meter.createCounter('cloud_trigger_stale_commits', {
      description: 'Run updates dropped because the run changed concurrently',
    });
    meter
      .createObservableGauge('cloud_trigger_worker_active_runs', {
        description: 'Runs currently executing on this instance',
      })
      .addCallback((result) => {
        result.observe(this.#activeRunsSource());
      });
  }

  observeActiveRuns(source: () => number): void {
    this.#activeRunsSource = source;
  }

  readonly record = (signal: EngineSignal): void => {
    switch (signal.kind) {
      case 'fired':
        this.#fires.add(signal.count, { reason: signal.reason });

        return;
      case 'fire_dropped':
        this.#firesDropped.add(1);

        return;
      case 'decision':
        this.#decisions.add(1, { decision: signal.decision });

        return;
      case 'attempt_started':
        if (signal.attempt === 1) {
          this.#startLag.record(Math.max(0, signal.lagMs) / MS_PER_SECOND, {
            target_type: signal.targetType,
          });
        }

        return;
      case 'lease_expired':
        this.#leaseExpirations.add(1);

        return;
      case 'stale_commit':
        this.#staleCommits.add(1);

        return;
      default:
        return assertNever(signal);
    }
  };

  async onRunLate(run: PendingRun | RunningRun): Promise<void> {
    this.#late.add(1, { job: run.jobName });
  }

  async onRunFinished(run: FinishedRun | SkippedRun, job: Job | undefined): Promise<void> {
    const labels = { status: run.status, target_type: job?.target.type ?? 'unknown' };
    this.#runs.add(1, labels);
    const durationMs = run.status === 'skipped' ? undefined : run.result?.durationMs;
    if (durationMs !== undefined) {
      this.#runDuration.record(durationMs / MS_PER_SECOND, labels);
    }
  }
}
