import type { FinishedRun, Job, SkippedRun } from '@cloud-trigger/core';

export interface RunLifecycleListener {
  onRunFinished(run: FinishedRun | SkippedRun, job: Job | undefined): Promise<void>;
}
