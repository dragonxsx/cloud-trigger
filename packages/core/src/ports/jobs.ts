import type { Result } from 'neverthrow';

import type { ConnectionRef } from '../domain/connection.js';
import type { GroupId, JobId } from '../domain/ids.js';
import type { Job, JobSortField, JobSpec, ScheduleState } from '../domain/job.js';
import type { PendingRun } from '../domain/run.js';
import type { DomainError, NotFoundError, VersionConflictError } from '../shared/errors.js';
import type { SortOrder } from '../shared/sort.js';
import type { Page, PageRequest } from './common.js';

export interface JobQuery extends PageRequest {
  readonly search?: string | undefined;
  readonly tag?: string | undefined;
  readonly groupId?: GroupId | undefined;
  readonly enabled?: boolean | undefined;
  readonly slaBreached?: boolean | undefined;
  readonly environment?: string | undefined;
  readonly sort?: { readonly field: JobSortField; readonly order: SortOrder } | undefined;
}

export interface JobUpdate {
  readonly spec: JobSpec;
  readonly updatedAt: Date;
  readonly upstreamJobIds?: readonly JobId[] | undefined;
  readonly connectionRefs?: readonly ConnectionRef[] | undefined;
  readonly eventSource?: string | null | undefined;
  /** Applied only while the stored schedule still matches `basedOn`. */
  readonly reschedule?:
    | {
        readonly nextFireAt: Date | null;
        readonly basedOn: Pick<ScheduleState, 'nextFireAt' | 'fireCount'>;
      }
    | undefined;
}

export type StaleClaimError = DomainError<'stale_claim'>;

export interface JobRepository {
  insert(job: Job): Promise<void>;
  get(id: JobId): Promise<Job | undefined>;
  list(query: JobQuery): Promise<Page<Job>>;
  update(
    id: JobId,
    update: JobUpdate,
    expectedVersion: number,
  ): Promise<Result<Job, VersionConflictError | NotFoundError>>;
  delete(id: JobId): Promise<boolean>;
  patchSchedule(
    id: JobId,
    patch: Partial<ScheduleState>,
    extra?: { pausedReason?: string | null; slaBreachedAt?: Date | null },
  ): Promise<void>;
  /** Atomically increments `consecutiveFailures` and pauses the job once it reaches `pauseAfter`. */
  recordFailure(id: JobId, p: { pauseAfter?: number | undefined }): Promise<void>;
  findDependants(jobId: JobId): Promise<readonly Job[]>;
  /** Jobs whose trigger or target uses the connection, or one of its endpoints when `endpoint` is given. */
  findByConnection(key: string, endpoint?: string): Promise<readonly Job[]>;
  /** Jobs whose own `environment` is the given one, not counting what they inherit. */
  findByEnvironment(environment: string): Promise<readonly Job[]>;
  /** Jobs whose trigger is a long-lived event source, enabled or not. */
  findEventSourced(): Promise<readonly Job[]>;
  findByName(name: string): Promise<readonly Job[]>;
  findStaleJobs(p: { now: Date; limit: number }): Promise<readonly Job[]>;
  updateSlaState(
    job: Job,
    update: { slaBreachedAt: Date | null; successDeadline: Date | null },
  ): Promise<boolean>;
}

export interface ScheduleStore {
  claimDue(p: {
    now: Date;
    ownerId: string;
    leaseMs: number;
    limit: number;
  }): Promise<readonly Job[]>;
  /** Fenced by the `ownerId` claim and `jobVersion`; returns the runs actually inserted. */
  commitFire(p: {
    jobId: JobId;
    jobVersion: number;
    ownerId: string;
    now: Date;
    runs: readonly PendingRun[];
    schedule: Pick<ScheduleState, 'nextFireAt' | 'lastFiredAt' | 'fireCount'>;
  }): Promise<Result<readonly PendingRun[], StaleClaimError>>;
}
