import {
  type FinishedRun,
  type Job,
  type JobRepository,
  type Logger,
  type Result,
  type Run,
  type RunRepository,
  type SkippedRun,
  type StaleRunError,
  isTerminal,
} from '@cloud-trigger/core';

import type { RunLifecycleListener } from './lifecycle.js';

export interface RunCompletionDeps {
  readonly jobs: JobRepository;
  readonly runs: RunRepository;
  readonly logger: Logger;
  readonly listeners: readonly RunLifecycleListener[];
}

export class RunCompletion {
  constructor(private readonly deps: RunCompletionDeps) {}

  async commit(
    previous: Run,
    next: Run,
    job: Job | undefined,
  ): Promise<Result<Run, StaleRunError>> {
    const saved = await this.deps.runs.transition(previous, next);
    if (saved.isErr() || !isTerminal(next)) {
      return saved;
    }
    if (job) {
      await this.#updateJobBookkeeping(job, next);
    }
    for (const listener of this.deps.listeners) {
      await listener
        .onRunFinished(next, job)
        .catch((error: unknown) =>
          this.deps.logger.error('Run listener failed', { runId: next.id, err: error }),
        );
    }

    return saved;
  }

  async #updateJobBookkeeping(job: Job, run: FinishedRun | SkippedRun): Promise<void> {
    if (run.status === 'skipped' || run.status === 'cancelled') {
      return;
    }
    if (run.status === 'succeeded') {
      await this.deps.jobs.patchSchedule(job.id, {
        lastSuccessAt: run.finishedAt,
        consecutiveFailures: 0,
      });
    } else {
      await this.deps.jobs.recordFailure(job.id, {
        pauseAfter: job.policy.pauseAfterConsecutiveFailures,
      });
    }
    await this.deps.runs.prune(job.id, {
      succeeded: job.policy.history.keepSucceeded,
      failed: job.policy.history.keepFailed,
    });
  }
}
