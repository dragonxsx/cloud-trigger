import type { Result } from 'neverthrow';

import type { JobId, RunId } from '../domain/ids.js';
import type { PendingRun, Run, RunReason, RunStatus, RunningRun } from '../domain/run.js';
import type { DomainError } from '../shared/errors.js';
import type { Page, PageRequest } from './common.js';

export interface RunQuery extends PageRequest {
  readonly jobId?: JobId | undefined;
  readonly status?: readonly RunStatus[] | undefined;
  readonly reason?: RunReason | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  readonly late?: boolean | undefined;
  readonly acknowledged?: boolean | undefined;
}

export interface SlaUpdate {
  readonly late: boolean;
  readonly lateReasons: readonly string[];
  readonly slaDeadline: Date | null;
}

export type StaleRunError = DomainError<'stale_run'>;

export interface RunRepository {
  insert(
    run: PendingRun,
    opts?: { durableKey?: boolean },
  ): Promise<Result<PendingRun, DomainError<'duplicate_run'>>>;
  get(id: RunId): Promise<Run | undefined>;
  list(query: RunQuery): Promise<Page<Run>>;
  transition(previous: Run, next: Run): Promise<Result<Run, StaleRunError>>;
  countByStatus(jobId: JobId, statuses: readonly RunStatus[]): Promise<number>;
  findByStatus(jobId: JobId, statuses: readonly RunStatus[]): Promise<readonly Run[]>;
  prune(jobId: JobId, keep: { succeeded: number; failed: number }): Promise<number>;
  countHoldingSlot(key: string): Promise<number>;
  markSlotHeld(run: RunningRun, key: string): Promise<boolean>;
  acknowledge(ids: readonly RunId[], at: Date): Promise<number>;
  findLateCandidates(p: {
    now: Date;
    limit: number;
  }): Promise<readonly (PendingRun | RunningRun)[]>;
  updateSla(run: PendingRun | RunningRun, update: SlaUpdate): Promise<boolean>;
}

export interface RunQueue {
  claimNext(p: { workerId: string; now: Date; leaseMs: number }): Promise<RunningRun | undefined>;
  renewLease(p: {
    runId: RunId;
    workerId: string;
    until: Date;
  }): Promise<{ renewed: boolean; cancelRequested: boolean }>;
  requestCancel(runId: RunId): Promise<boolean>;
  findExpired(p: { now: Date; limit: number }): Promise<readonly RunningRun[]>;
  /** Claims the job's single execution slot; false if held. */
  acquireExecution(run: RunningRun): Promise<boolean>;
  /** Re-pends as the job's single buffered run; `buffer_full` if taken. */
  buffer(
    previous: RunningRun,
    next: PendingRun,
  ): Promise<Result<PendingRun, StaleRunError | DomainError<'buffer_full'>>>;
}
