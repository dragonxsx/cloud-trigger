import {
  type Clock,
  type GroupRepository,
  type Job,
  type JobId,
  type JobRepository,
  type Logger,
  type PendingRun,
  type RunRepository,
  type RunningRun,
  checkJobSla,
  checkRunSla,
} from '@cloud-trigger/core';

import { markRunLate } from './late-runs.js';
import type { RunLifecycleListener } from './lifecycle.js';
import { PollingLoop } from './loop.js';
import type { NotificationEnqueuer } from './notification-listener.js';
import { PolicyResolver } from './policies.js';

export interface SlaMonitorDeps {
  readonly jobs: JobRepository;
  readonly runs: RunRepository;
  readonly enqueuer: NotificationEnqueuer;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly listeners: readonly RunLifecycleListener[];
  readonly groups?: GroupRepository | undefined;
}

export interface SlaMonitorOptions {
  readonly intervalMs: number;
  readonly batchSize: number;
}

export class SlaMonitor {
  readonly #loop: PollingLoop;
  readonly #policies: PolicyResolver;

  constructor(
    private readonly deps: SlaMonitorDeps,
    private readonly options: SlaMonitorOptions,
  ) {
    this.#loop = new PollingLoop('sla-monitor', options.intervalMs, () => this.tick(), deps.logger);
    this.#policies = new PolicyResolver(deps.groups, deps.clock);
  }

  start(): void {
    this.#loop.start();
  }

  stop(): Promise<void> {
    return this.#loop.stop();
  }

  async tick(): Promise<boolean> {
    const now = this.deps.clock.now();
    const [runs, jobs] = await Promise.all([
      this.deps.runs.findLateCandidates({ now, limit: this.options.batchSize }),
      this.deps.jobs.findStaleJobs({ now, limit: this.options.batchSize }),
    ]);
    const jobCache = new Map<JobId, Promise<Job | undefined>>();
    const jobOf = (id: JobId) => {
      const cached = jobCache.get(id) ?? this.deps.jobs.get(id);
      jobCache.set(id, cached);

      return cached;
    };
    for (const run of runs) {
      await this.#checkRun(run, await jobOf(run.jobId), now);
    }
    for (const job of jobs) {
      await this.#checkJob(job, now);
    }

    return runs.length === this.options.batchSize || jobs.length === this.options.batchSize;
  }

  async #checkRun(run: PendingRun | RunningRun, job: Job | undefined, now: Date): Promise<void> {
    if (!job) {
      await this.deps.runs.updateSla(run, { late: false, lateReasons: [], slaDeadline: null });

      return;
    }
    const { policy } = await this.#policies.resolve(job);
    const check = checkRunSla(run, policy.sla, now);
    if (check.reasons.length === 0) {
      await this.deps.runs.updateSla(run, {
        late: false,
        lateReasons: [],
        slaDeadline: check.nextDeadline,
      });

      return;
    }
    await markRunLate(this.deps, run, job, check.reasons);
  }

  async #checkJob(job: Job, now: Date): Promise<void> {
    const { policy } = await this.#policies.resolve(job);
    const check = checkJobSla(job, policy.sla, now);
    if (check.reasons.length === 0) {
      await this.deps.jobs.updateSlaState(job, {
        slaBreachedAt: null,
        successDeadline: check.nextDeadline,
      });

      return;
    }
    const deadline = job.schedule.successDeadline ?? now;
    if (
      !(await this.deps.jobs.updateSlaState(job, { slaBreachedAt: now, successDeadline: null }))
    ) {
      return;
    }
    this.deps.logger.warn('Job breached its since-last-success SLA', { jobId: job.id });
    await this.deps.enqueuer.forJob(job, 'late', {
      subject: `${job.id}:sla:${deadline.toISOString()}`,
      status: 'sla_breached',
      lateReasons: check.reasons,
    });
  }
}
