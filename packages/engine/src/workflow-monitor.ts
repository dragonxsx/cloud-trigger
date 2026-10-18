import {
  type Clock,
  type Logger,
  type ProviderRegistry,
  type WorkflowRepository,
  type WorkflowRunRepository,
  expireApprovals,
} from '@cloud-trigger/core';

import { PollingLoop } from './loop.js';
import { type WorkflowRuntime, workflowScheduleKey } from './workflow-runtime.js';

export interface WorkflowMonitorDeps {
  readonly workflows: WorkflowRepository;
  readonly workflowRuns: WorkflowRunRepository;
  readonly registry: ProviderRegistry;
  readonly runtime: WorkflowRuntime;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface WorkflowMonitorOptions {
  readonly intervalMs: number;
  readonly batchSize: number;
}

export class WorkflowMonitor {
  readonly #loop: PollingLoop;

  constructor(
    private readonly deps: WorkflowMonitorDeps,
    private readonly options: WorkflowMonitorOptions,
  ) {
    this.#loop = new PollingLoop(
      'workflow-monitor',
      options.intervalMs,
      () => this.tick(),
      deps.logger,
    );
  }

  start(): void {
    this.#loop.start();
  }

  stop(): Promise<void> {
    return this.#loop.stop();
  }

  async tick(): Promise<boolean> {
    const fired = await this.#fireDue();
    const expired = await this.#expireApprovals();
    await this.#repairQueued();

    return fired + expired >= this.options.batchSize;
  }

  async #fireDue(): Promise<number> {
    const now = this.deps.clock.now();
    const due = await this.deps.workflows.findDue({ now, limit: this.options.batchSize });
    let fired = 0;
    for (const workflow of due) {
      const at = workflow.nextFireAt;
      const schedule = workflow.schedule;
      if (at === null || schedule === null) {
        continue;
      }
      const trigger = this.deps.registry
        .get('trigger', schedule.type)
        .andThen((provider) => provider.bind(schedule.config));
      const next = trigger.isOk()
        ? trigger.value.nextFireAt({
            after: now,
            lastFiredAt: at,
            fireCount: 1,
            jobId: workflow.id,
          })
        : null;
      if (!(await this.deps.workflows.advanceSchedule(workflow.id, { from: at, to: next }))) {
        continue;
      }
      await this.deps.runtime.start(workflow, {
        reason: 'scheduled',
        idempotencyKey: workflowScheduleKey(workflow.id, at),
      });
      fired++;
    }

    return fired;
  }

  async #expireApprovals(): Promise<number> {
    const now = this.deps.clock.now();
    const runs = await this.deps.workflowRuns.findExpiredApprovals({
      now,
      limit: this.options.batchSize,
    });
    for (const run of runs) {
      await this.deps.runtime.mutate(run.id, (current) => expireApprovals(current, now));
    }

    return runs.length;
  }

  async #repairQueued(): Promise<void> {
    const runs = await this.deps.workflowRuns.findWithQueuedNodes({
      limit: this.options.batchSize,
    });
    for (const run of runs) {
      for (const [key, state] of Object.entries(run.nodes)) {
        if (state.status === 'queued') {
          await this.deps.runtime.ensureNodeRun(run, key);
        }
      }
    }
  }
}
