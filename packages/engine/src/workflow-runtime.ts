import {
  type Clock,
  type FinishedRun,
  type GroupRepository,
  type JobRepository,
  type Logger,
  type NodeOutcome,
  type ParentSnapshot,
  type RunRepository,
  type SkippedRun,
  type Transition,
  type Workflow,
  type WorkflowEffect,
  type WorkflowRun,
  type WorkflowRunId,
  type WorkflowRunRepository,
  assertNever,
  completeNode,
  newPendingRun,
  newWorkflowRunId,
  nodeJobIds,
  parentSnapshotOf,
  parentsOf,
  startWorkflowRun,
} from '@cloud-trigger/core';

import type { RunLifecycleListener } from './lifecycle.js';
import { PolicyResolver } from './policies.js';

export interface WorkflowRuntimeDeps {
  readonly jobs: JobRepository;
  readonly runs: RunRepository;
  readonly workflowRuns: WorkflowRunRepository;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly groups?: GroupRepository | undefined;
}

export const workflowNodeKey = (workflowRunId: string, node: string) =>
  `wf:${workflowRunId}:${node}`;
export const workflowScheduleKey = (workflowId: string, at: Date) =>
  `wfsched:${workflowId}:${at.toISOString()}`;

const MAX_CAS_ATTEMPTS = 8;

export const outcomeOf = (run: FinishedRun | SkippedRun): NodeOutcome => {
  switch (run.status) {
    case 'succeeded':
      return 'succeeded';
    case 'failed':
    case 'timed_out':
    case 'skipped':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return assertNever(run);
  }
};

export class WorkflowRuntime {
  readonly #policies: PolicyResolver;

  constructor(private readonly deps: WorkflowRuntimeDeps) {
    this.#policies = new PolicyResolver(deps.groups, deps.clock);
  }

  async start(
    workflow: Workflow,
    p: { reason: 'manual' | 'scheduled'; idempotencyKey?: string | undefined },
  ): Promise<WorkflowRun | undefined> {
    const now = this.deps.clock.now();
    const started = startWorkflowRun(workflow, {
      id: newWorkflowRunId(),
      jobIds: nodeJobIds(workflow),
      reason: p.reason,
      idempotencyKey: p.idempotencyKey ?? null,
      now,
    });
    const inserted = await this.deps.workflowRuns.insert(started.run);
    if (inserted.isErr()) {
      return undefined;
    }
    await this.#applyStarts(started.run, started.effects);
    this.deps.logger.info('Workflow started', {
      workflowId: workflow.id,
      workflowRunId: started.run.id,
    });

    return started.run;
  }

  async mutate(
    id: WorkflowRunId,
    change: (run: WorkflowRun) => Transition | undefined,
  ): Promise<{ run: WorkflowRun; cancels: readonly WorkflowEffect[] } | undefined> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const current = await this.deps.workflowRuns.get(id);
      const next = current && change(current);
      if (!current || !next) {
        return undefined;
      }
      const saved = await this.deps.workflowRuns.update(next.run, current.version);
      if (saved.isOk()) {
        return { run: saved.value, cancels: await this.#applyStarts(saved.value, next.effects) };
      }
    }
    this.deps.logger.warn('Workflow run kept changing; giving up this update', {
      workflowRunId: id,
    });

    return undefined;
  }

  async #applyStarts(
    run: WorkflowRun,
    effects: readonly WorkflowEffect[],
  ): Promise<readonly WorkflowEffect[]> {
    const cancels: WorkflowEffect[] = [];
    for (const effect of effects) {
      if (effect.type === 'start_job') {
        await this.ensureNodeRun(run, effect.key);
      } else {
        cancels.push(effect);
      }
    }

    return cancels;
  }

  async #parentOf(run: WorkflowRun, key: string): Promise<ParentSnapshot | null> {
    for (const edge of parentsOf(run.graph, key)) {
      const parentRunId = run.nodes[edge.from]?.runId;
      const parent = parentRunId ? await this.deps.runs.get(parentRunId) : undefined;
      if (parent) {
        return parentSnapshotOf(parent);
      }
    }

    return null;
  }

  async ensureNodeRun(run: WorkflowRun, key: string): Promise<void> {
    const state = run.nodes[key];
    const jobId = run.jobIds[key];
    const runId = state?.status === 'queued' ? state.runId : null;
    if (runId === null) {
      return;
    }
    const existing = await this.deps.runs.get(runId);
    if (existing) {
      if (existing.status !== 'pending' && existing.status !== 'running') {
        await this.completeFromRun(existing);
      }

      return;
    }
    const job = jobId === undefined ? undefined : await this.deps.jobs.get(jobId);
    const now = this.deps.clock.now();
    if (!job) {
      await this.mutate(run.id, (current) => completeNode(current, key, 'failed', { runId, now }));

      return;
    }
    const { policy } = await this.#policies.resolve(job);
    await this.deps.runs.insert(
      newPendingRun({
        id: runId,
        job,
        reason: 'workflow',
        scheduledAt: now,
        idempotencyKey: workflowNodeKey(run.id, key),
        workflow: { runId: run.id, node: key },
        parent: await this.#parentOf(run, key),
        sla: policy.sla,
        now,
      }),
      { durableKey: true },
    );
  }

  async completeFromRun(run: FinishedRun | SkippedRun): Promise<void> {
    const ref = run.workflow;
    if (!ref) {
      return;
    }
    await this.mutate(ref.runId, (current) =>
      completeNode(current, ref.node, outcomeOf(run), {
        runId: run.id,
        now: this.deps.clock.now(),
      }),
    );
  }
}

export class WorkflowAdvancer implements RunLifecycleListener {
  constructor(private readonly runtime: WorkflowRuntime) {}

  async onRunFinished(run: FinishedRun | SkippedRun): Promise<void> {
    await this.runtime.completeFromRun(run);
  }
}
