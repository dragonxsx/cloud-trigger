import {
  type Clock,
  type DecisionLog,
  type GroupRepository,
  type Job,
  type JobRepository,
  type Logger,
  type ProviderRegistry,
  type ScheduleStore,
  newPendingRun,
  newRunId,
} from '@cloud-trigger/core';

import { bindJob } from './config-validation.js';
import { DecisionRecorder } from './decisions.js';
import { jitteredAvailableAt, planFires } from './fire-plan.js';
import { PollingLoop } from './loop.js';
import { PolicyResolver } from './policies.js';

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
  readonly groups?: GroupRepository | undefined;
  readonly decisions?: DecisionLog | undefined;
}

export class Scheduler {
  readonly #loop: PollingLoop;
  readonly #policies: PolicyResolver;
  readonly #decisions: DecisionRecorder;

  constructor(
    private readonly deps: SchedulerDeps,
    private readonly options: SchedulerOptions,
  ) {
    this.#loop = new PollingLoop('scheduler', options.intervalMs, () => this.tick(), deps.logger);
    this.#policies = new PolicyResolver(deps.groups, deps.clock);
    this.#decisions = new DecisionRecorder(deps.decisions, deps.clock, deps.logger);
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
      const pausedReason = `Invalid configuration: ${bound.error.issues.map((i) => i.path).join(', ')}`;
      await this.deps.jobs.patchSchedule(job.id, {}, { pausedReason });
      await this.#decisions.record({
        jobId: job.id,
        fireTime: job.schedule.nextFireAt,
        decision: 'paused',
        detail: pausedReason,
      });

      return;
    }

    const { policy } = await this.#policies.resolve(job);
    const plan = planFires({ job, trigger: bound.value.trigger, misfire: policy.misfire, now });
    const runs = plan.fires.map((fire) =>
      newPendingRun({
        id: newRunId(),
        job,
        reason: fire.reason,
        scheduledAt: fire.scheduledAt,
        availableAt: jitteredAvailableAt(fire.scheduledAt, job.trigger.jitterMs, plan.nextFireAt),
        idempotencyKey: `sched:${job.id}:${fire.scheduledAt.toISOString()}`,
        sla: policy.sla,
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
        mode: policy.misfire.mode,
      });
      await this.#decisions.record({
        jobId: job.id,
        fireTime: job.schedule.nextFireAt,
        decision: 'misfire_skipped',
        detail: `Skipped ${plan.skippedCount} missed fire time(s) older than ${policy.misfire.graceMs} ms (misfire: ${policy.misfire.mode})`,
      });
    }
    const catchups = plan.fires.filter((f) => f.reason === 'catchup');
    if (catchups.length > 0) {
      await this.#decisions.record({
        jobId: job.id,
        fireTime: catchups[0]?.scheduledAt ?? null,
        decision: 'catchup',
        detail: `Queued ${catchups.length} catch-up run(s) for fire times missed during downtime`,
      });
    }
    if (plan.nextFireAt === null) {
      await this.#decisions.record({
        jobId: job.id,
        fireTime: lastFire,
        decision: 'finished',
        detail: 'The trigger has no further fire times',
      });
    }
    this.deps.logger.debug('Fired job', {
      jobId: job.id,
      runs: committed.value.length,
      nextFireAt: plan.nextFireAt?.toISOString(),
    });
  }
}
