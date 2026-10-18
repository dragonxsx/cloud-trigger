import {
  type Clock,
  type DecisionLog,
  type FinishedRun,
  type GroupRepository,
  type Job,
  type JobPolicy,
  type JobRepository,
  type Logger,
  type RateLimiter,
  type Result,
  type Run,
  type RunRepository,
  type SkippedRun,
  type StaleRunError,
  isFailedRetry,
  isTerminal,
  successDeadlineAfter,
} from '@cloud-trigger/core';

import { DecisionRecorder } from './decisions.js';
import type { RunLifecycleListener } from './lifecycle.js';
import { PolicyResolver } from './policies.js';

export interface RunCompletionDeps {
  readonly jobs: JobRepository;
  readonly runs: RunRepository;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly listeners: readonly RunLifecycleListener[];
  readonly groups?: GroupRepository | undefined;
  readonly rateLimiter?: RateLimiter | undefined;
  readonly decisions?: DecisionLog | undefined;
}

export class RunCompletion {
  readonly #policies: PolicyResolver;
  readonly #decisions: DecisionRecorder;

  constructor(private readonly deps: RunCompletionDeps) {
    this.#policies = new PolicyResolver(deps.groups, deps.clock);
    this.#decisions = new DecisionRecorder(deps.decisions, deps.clock, deps.logger);
  }

  async commit(
    previous: Run,
    next: Run,
    job: Job | undefined,
  ): Promise<Result<Run, StaleRunError>> {
    const saved = await this.deps.runs.transition(previous, next);
    if (saved.isErr()) {
      return saved;
    }
    const stored = saved.value;
    if (previous.status === 'running' && previous.rateLimitKey !== null) {
      await this.deps.rateLimiter?.release(previous.rateLimitKey, this.deps.clock.now());
    }
    if (stored.status === 'pending' && isFailedRetry(previous, stored)) {
      await this.#notify(stored.id, (listener) => listener.onAttemptFailed?.(stored, job));
    }
    if (!isTerminal(stored)) {
      return saved;
    }
    if (job) {
      const { policy } = await this.#policies.resolve(job);
      await this.#updateJobBookkeeping(job, policy, stored);
    }
    await this.#notify(stored.id, (listener) => listener.onRunFinished(stored, job));

    return saved;
  }

  async #notify(
    runId: string,
    call: (listener: RunLifecycleListener) => Promise<void> | undefined,
  ): Promise<void> {
    for (const listener of this.deps.listeners) {
      await Promise.resolve(call(listener)).catch((error: unknown) =>
        this.deps.logger.error('Run listener failed', { runId, err: error }),
      );
    }
  }

  async #updateJobBookkeeping(
    job: Job,
    policy: JobPolicy,
    run: FinishedRun | SkippedRun,
  ): Promise<void> {
    if (run.status === 'skipped' || run.status === 'cancelled') {
      return;
    }
    if (run.status === 'succeeded') {
      await this.deps.jobs.patchSchedule(
        job.id,
        {
          lastSuccessAt: run.finishedAt,
          consecutiveFailures: 0,
          successDeadline: successDeadlineAfter(run.finishedAt, policy.sla.maxSinceLastSuccessMs),
        },
        { slaBreachedAt: null },
      );
    } else {
      await this.deps.jobs.recordFailure(job.id, {
        pauseAfter: policy.pauseAfterConsecutiveFailures,
      });
      if (policy.pauseAfterConsecutiveFailures !== undefined && job.pausedReason === null) {
        const after = await this.deps.jobs.get(job.id);
        if (after?.pausedReason) {
          await this.#decisions.record({
            jobId: job.id,
            runId: run.id,
            fireTime: run.scheduledAt,
            decision: 'paused',
            detail: after.pausedReason,
          });
        }
      }
    }
    await this.deps.runs.prune(job.id, {
      succeeded: policy.history.keepSucceeded,
      failed: policy.history.keepFailed,
    });
  }
}
