import type { Job, Logger, PendingRun, RunRepository, RunningRun } from '@cloud-trigger/core';

import type { RunLifecycleListener } from './lifecycle.js';

export interface LateRunDeps {
  readonly runs: RunRepository;
  readonly logger: Logger;
  readonly listeners: readonly RunLifecycleListener[];
}

export async function markRunLate(
  deps: LateRunDeps,
  run: PendingRun | RunningRun,
  job: Job,
  reasons: readonly string[],
): Promise<boolean> {
  const late = { ...run, late: true, lateReasons: [...reasons], slaDeadline: null };
  if (!(await deps.runs.updateSla(run, late))) {
    return false;
  }
  deps.logger.warn('Run breached its SLA', { runId: run.id, reasons });
  for (const listener of deps.listeners) {
    await listener
      .onRunLate?.(late, job)
      .catch((error: unknown) =>
        deps.logger.error('Late listener failed', { runId: run.id, err: error }),
      );
  }

  return true;
}
