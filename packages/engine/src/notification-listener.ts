import {
  type Clock,
  type FinishedRun,
  type GroupRepository,
  type Job,
  type NotificationEvent,
  type NotificationOutbox,
  type NotificationRule,
  type PendingRun,
  type Run,
  type SkippedRun,
  type TargetResult,
  assertNever,
  eventsForFinishedRun,
  newDeliveries,
} from '@cloud-trigger/core';

import type { RunLifecycleListener } from './lifecycle.js';
import { PolicyResolver } from './policies.js';

const resultOf = (run: Run): TargetResult | null => {
  switch (run.status) {
    case 'succeeded':
    case 'failed':
    case 'timed_out':
    case 'cancelled':
      return run.result;
    case 'pending':
    case 'running':
    case 'skipped':
      return run.attempts.at(-1)?.result ?? null;
    default:
      return assertNever(run);
  }
};

export interface NotificationEnqueuerDeps {
  readonly outbox: NotificationOutbox;
  readonly clock: Clock;
  readonly groups?: GroupRepository | undefined;
}

export class NotificationEnqueuer {
  readonly #policies: PolicyResolver;

  constructor(private readonly deps: NotificationEnqueuerDeps) {
    this.#policies = new PolicyResolver(deps.groups, deps.clock);
  }

  async #rulesFor(
    job: Job,
  ): Promise<{ rules: readonly NotificationRule[]; environment: string | null }> {
    const { notifications, environment } = await this.#policies.resolve(job);

    return { rules: notifications, environment };
  }

  async forRun(
    run: Run,
    job: Job,
    event: NotificationEvent,
    subject: string = run.id,
  ): Promise<number> {
    const now = this.deps.clock.now();

    return this.deps.outbox.enqueue(
      newDeliveries({
        ...(await this.#rulesFor(job)),
        subject,
        now,
        event: {
          event,
          jobId: job.id,
          jobName: job.name,
          runId: run.id,
          status: run.status,
          attempt: run.attempts.length,
          scheduledAt: run.scheduledAt,
          lateReasons: run.lateReasons,
          result: resultOf(run),
          occurredAt: now,
        },
      }),
    );
  }

  async forJob(
    job: Job,
    event: NotificationEvent,
    p: { subject: string; status: string; lateReasons: readonly string[] },
  ): Promise<number> {
    const now = this.deps.clock.now();

    return this.deps.outbox.enqueue(
      newDeliveries({
        ...(await this.#rulesFor(job)),
        subject: p.subject,
        now,
        event: {
          event,
          jobId: job.id,
          jobName: job.name,
          runId: null,
          status: p.status,
          attempt: 0,
          scheduledAt: null,
          lateReasons: [...p.lateReasons],
          result: null,
          occurredAt: now,
        },
      }),
    );
  }
}

export class NotificationListener implements RunLifecycleListener {
  constructor(private readonly enqueuer: NotificationEnqueuer) {}

  async onRunFinished(run: FinishedRun | SkippedRun, job: Job | undefined): Promise<void> {
    if (!job) {
      return;
    }
    for (const event of eventsForFinishedRun(run)) {
      await this.enqueuer.forRun(run, job, event);
    }
  }

  async onAttemptFailed(run: PendingRun, job: Job | undefined): Promise<void> {
    if (job) {
      await this.enqueuer.forRun(run, job, 'failure', `${run.id}:${run.attempts.length}`);
    }
  }
}
