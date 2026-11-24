import {
  type Clock,
  type Logger,
  type ProviderRegistry,
  type Workflow,
  type WorkflowRepository,
  type WorkflowRunId,
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
  #repairCursor: WorkflowRunId | undefined;

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
      try {
        if (await this.#fire(workflow, now)) {
          fired++;
        }
      } catch (error: unknown) {
        this.deps.logger.error('Could not fire scheduled workflow', {
          workflowId: workflow.id,
          err: error,
        });
      }
    }

    return fired;
  }

  async #fire(workflow: Workflow, now: Date): Promise<boolean> {
    const at = workflow.nextFireAt;
    const schedule = workflow.schedule;
    if (at === null || schedule === null) {
      return false;
    }
    const fireCount = workflow.fireCount + 1;
    const trigger = this.deps.registry
      .get('trigger', schedule.type)
      .andThen((provider) => provider.bind(schedule.config));
    const next = trigger.isOk()
      ? trigger.value.nextFireAt({ after: now, lastFiredAt: at, fireCount, jobId: workflow.id })
      : null;
    const started = this.deps.runtime.prepareStart(workflow, {
      reason: 'scheduled',
      idempotencyKey: workflowScheduleKey(workflow.id, at),
    });
    const inserted = await this.deps.workflows.fireSchedule({
      id: workflow.id,
      from: at,
      schedule: { nextFireAt: next, lastFiredAt: at, fireCount },
      run: started.run,
    });
    if (!inserted) {
      return false;
    }
    if (next === null) {
      this.deps.logger.info('Workflow schedule finished', { workflowId: workflow.id, fireCount });
    }
    await this.deps.runtime.afterStart(started);

    return true;
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
      after: this.#repairCursor,
    });
    this.#repairCursor = runs.length < this.options.batchSize ? undefined : runs.at(-1)?.id;
    for (const run of runs) {
      for (const [key, state] of Object.entries(run.nodes)) {
        if (state.status === 'queued') {
          await this.deps.runtime.ensureNodeRun(run, key);
        }
      }
    }
  }
}
