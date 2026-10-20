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
  readonly nextFireAt: Date | null;
  readonly updatedAt: Date;
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
  /** Moves `nextFireAt` from `from` to `to`; false when another replica already did. */
  advanceSchedule(id: WorkflowId, p: { from: Date; to: Date | null }): Promise<boolean>;
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
  findWithQueuedNodes(p: { limit: number }): Promise<readonly WorkflowRun[]>;
}
