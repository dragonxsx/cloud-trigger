import {
  type Clock,
  type FinishedRun,
  type GroupRepository,
  type Job,
  type JobRepository,
  type Logger,
  type ProviderRegistry,
  type RunRepository,
  type SkippedRun,
  type TriggerEvent,
  assertNever,
  isSchedulable,
  newPendingRun,
  newRunId,
  parentSnapshotOf,
} from '@cloud-trigger/core';

import type { RunLifecycleListener } from './lifecycle.js';
import { PolicyResolver } from './policies.js';

export interface ChainListenerDeps {
  readonly jobs: JobRepository;
  readonly runs: RunRepository;
  readonly registry: ProviderRegistry;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly groups?: GroupRepository | undefined;
}

const eventFor = (run: FinishedRun | SkippedRun): TriggerEvent | undefined => {
  switch (run.status) {
    case 'succeeded':
    case 'failed':
    case 'timed_out':
      return { kind: 'run_finished', jobId: run.jobId, runId: run.id, status: run.status };
    case 'cancelled':
    case 'skipped':
      return undefined;
    default:
      return assertNever(run);
  }
};

export const chainKey = (parentRunId: string, childJobId: string) =>
  `chain:${parentRunId}:${childJobId}`;

export class ChainListener implements RunLifecycleListener {
  readonly #policies: PolicyResolver;

  constructor(private readonly deps: ChainListenerDeps) {
    this.#policies = new PolicyResolver(deps.groups, deps.clock);
  }

  async onRunFinished(run: FinishedRun | SkippedRun, job: Job | undefined): Promise<void> {
    const event = eventFor(run);
    if (!event || !job) {
      return;
    }
    for (const child of await this.deps.jobs.findDependants(job.id)) {
      if (isSchedulable(child)) {
        await this.#start(child, run, event);
      }
    }
  }

  async #start(child: Job, parent: FinishedRun | SkippedRun, event: TriggerEvent): Promise<void> {
    const trigger = this.deps.registry
      .get('trigger', child.trigger.type)
      .andThen((provider) => provider.bind(child.trigger.config));
    if (trigger.isErr() || trigger.value.matches?.(event) !== true) {
      return;
    }
    const now = this.deps.clock.now();
    const { policy } = await this.#policies.resolve(child);
    const inserted = await this.deps.runs.insert(
      newPendingRun({
        id: newRunId(),
        job: child,
        reason: 'chained',
        scheduledAt: now,
        idempotencyKey: chainKey(parent.id, child.id),
        parent: parentSnapshotOf(parent),
        sla: policy.sla,
        now,
      }),
    );
    if (inserted.isOk()) {
      this.deps.logger.info('Chained run queued', {
        parentRunId: parent.id,
        jobId: child.id,
        runId: inserted.value.id,
      });
    }
  }
}
