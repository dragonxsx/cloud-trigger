import {
  type Clock,
  type Job,
  type JobRepository,
  type Logger,
  type ProviderRegistry,
  type ScheduleStore,
  newPendingRun,
  newRunId,
} from '@cloud-trigger/core';

import { bindJob } from './config-validation.js';
import { jitteredAvailableAt, planFires } from './fire-plan.js';
import { PollingLoop } from './loop.js';

export interface SchedulerOptions {
  readonly ownerId: string;
  readonly intervalMs: number;
  readonly claimLeaseMs: number;
  readonly batchSize: number;
}

export interface SchedulerDeps {
  readonly schedule: ScheduleStore;
  readonly jobs: JobRepository;
  readonly registry: ProviderRegistry;
  readonly clock: Clock;
  readonly logger: Logger;
}

export class Scheduler {
  readonly #loop: PollingLoop;

  constructor(
    private readonly deps: SchedulerDeps,
    private readonly options: SchedulerOptions,
  ) {
    this.#loop = new PollingLoop('scheduler', options.intervalMs, () => this.tick(), deps.logger);
  }

  start(): void {
    this.#loop.start();
  }

  stop(): Promise<void> {
    return this.#loop.stop();
  }

  async tick(): Promise<boolean> {
    const now = this.deps.clock.now();
    const due = await this.deps.schedule.claimDue({
      now,
      ownerId: this.options.ownerId,
      leaseMs: this.options.claimLeaseMs,
      limit: this.options.batchSize,
    });
    for (const job of due) {
      await this.#fire(job, now);
    }

    return due.length === this.options.batchSize;
  }

  async #fire(job: Job, now: Date): Promise<void> {
    const bound = bindJob(this.deps.registry, job);
    if (bound.isErr()) {
      this.deps.logger.warn('Pausing job with invalid configuration', {
        jobId: job.id,
        issues: bound.error.issues,
      });
      await this.deps.jobs.patchSchedule(
        job.id,
        {},
        {
          pausedReason: `Invalid configuration: ${bound.error.issues.map((i) => i.path).join(', ')}`,
        },
      );

      return;
    }

    const plan = planFires({ job, trigger: bound.value.trigger, misfire: job.policy.misfire, now });
    const runs = plan.fires.map((fire) =>
      newPendingRun({
        id: newRunId(),
        job,
        reason: fire.reason,
        scheduledAt: fire.scheduledAt,
        availableAt: jitteredAvailableAt(fire.scheduledAt, job.trigger.jitterMs, plan.nextFireAt),
        idempotencyKey: `sched:${job.id}:${fire.scheduledAt.toISOString()}`,
        now,
      }),
    );
    const lastFire = plan.fires.at(-1)?.scheduledAt ?? job.schedule.lastFiredAt;
    const committed = await this.deps.schedule.commitFire({
      jobId: job.id,
      jobVersion: job.version,
      ownerId: this.options.ownerId,
      now: this.deps.clock.now(),
      runs,
      schedule: {
        nextFireAt: plan.nextFireAt,
        lastFiredAt: lastFire,
        fireCount: job.schedule.fireCount + plan.fires.length,
      },
    });
    if (committed.isErr()) {
      this.deps.logger.warn('Dropping fire: scheduler claim was lost', { jobId: job.id });

      return;
    }
    if (plan.skippedCount > 0) {
      this.deps.logger.info('Skipped missed fire times per misfire policy', {
        jobId: job.id,
        skipped: plan.skippedCount,
        mode: job.policy.misfire.mode,
      });
    }
    this.deps.logger.debug('Fired job', {
      jobId: job.id,
      runs: committed.value.length,
      nextFireAt: plan.nextFireAt?.toISOString(),
    });
  }
}
