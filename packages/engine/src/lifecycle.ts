import type { FinishedRun, Job, PendingRun, RunningRun, SkippedRun } from '@cloud-trigger/core';

export interface RunLifecycleListener {
  onRunFinished(run: FinishedRun | SkippedRun, job: Job | undefined): Promise<void>;
  onAttemptFailed?(run: PendingRun, job: Job | undefined): Promise<void>;
  onRunLate?(run: PendingRun | RunningRun, job: Job): Promise<void>;
}
