import type { Result } from 'neverthrow';

import type { JobId, WorkflowId, WorkflowRunId } from '../domain/ids.js';
import type { WorkflowRun, WorkflowRunStatus } from '../domain/workflow-run.js';
import type { Workflow, WorkflowSpec } from '../domain/workflow.js';
import type { DomainError, NotFoundError, VersionConflictError } from '../shared/errors.js';
import type { Page, PageRequest } from './common.js';

export interface WorkflowQuery extends PageRequest {
  readonly search?: string | undefined;
}

export interface WorkflowChange {
  readonly spec: WorkflowSpec;
  readonly inlineJobIds: Readonly<Record<string, JobId>>;
  readonly nextFireAt?: Date | null | undefined;
  /** With `nextFireAt`: the schedule state it was computed from; a fire since then is a version conflict. */
  readonly basedOn?: WorkflowScheduleBasis | undefined;
  readonly updatedAt: Date;
}

export interface WorkflowScheduleBasis {
  readonly nextFireAt: Date | null;
  readonly fireCount: number;
}

export interface WorkflowFire {
  readonly id: WorkflowId;
  /** The `nextFireAt` the fire was found due at; the fire is refused when it moved or the workflow is disabled. */
  readonly from: Date;
  readonly schedule: {
    readonly nextFireAt: Date | null;
    readonly lastFiredAt: Date;
    readonly fireCount: number;
  };
  readonly run: WorkflowRun;
}

export interface WorkflowRepository {
  insert(workflow: Workflow): Promise<void>;
  get(id: WorkflowId): Promise<Workflow | undefined>;
  list(query: WorkflowQuery): Promise<Page<Workflow>>;
  update(
    id: WorkflowId,
    change: WorkflowChange,
    expectedVersion: number,
  ): Promise<Result<Workflow, VersionConflictError | NotFoundError>>;
  delete(id: WorkflowId): Promise<boolean>;
  findByEnvironment(environment: string): Promise<readonly Workflow[]>;
  /** Enabled workflows whose schedule is due. */
  findDue(p: { now: Date; limit: number }): Promise<readonly Workflow[]>;
  /**
   * Atomically advances the schedule and inserts the occurrence's run (deduplicated by its key).
   * Returns true only when this call inserted the run.
   */
  fireSchedule(fire: WorkflowFire): Promise<boolean>;
}

export interface WorkflowRunQuery extends PageRequest {
  readonly workflowId?: WorkflowId | undefined;
  readonly status?: readonly WorkflowRunStatus[] | undefined;
}

export type DuplicateWorkflowRunError = DomainError<'duplicate_run'>;
export type StaleWorkflowRunError = DomainError<'stale_run'>;

export interface WorkflowRunRepository {
  insert(run: WorkflowRun): Promise<Result<WorkflowRun, DuplicateWorkflowRunError>>;
  get(id: WorkflowRunId): Promise<WorkflowRun | undefined>;
  list(query: WorkflowRunQuery): Promise<Page<WorkflowRun>>;
  /** Writes `next` with version `expectedVersion + 1` if the stored version still matches. */
  update(
    next: WorkflowRun,
    expectedVersion: number,
  ): Promise<Result<WorkflowRun, StaleWorkflowRunError>>;
  findExpiredApprovals(p: { now: Date; limit: number }): Promise<readonly WorkflowRun[]>;
  /** Runs with queued nodes in id order, after `after` when given. */
  findWithQueuedNodes(p: {
    limit: number;
    after?: WorkflowRunId | undefined;
  }): Promise<readonly WorkflowRun[]>;
}
