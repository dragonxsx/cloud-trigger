import type { ConnectionInUseError } from '../ports/connections.js';
import type { ConflictError } from '../ports/groups.js';
import type { StaleClaimError } from '../ports/jobs.js';
import type { StaleRunError } from '../ports/runs.js';
import type { DomainError, NotFoundError, VersionConflictError } from '../shared/errors.js';

export type StoredEntity = 'Job' | 'Group' | 'Workflow' | 'User' | 'Connection';

export const notFound = (entity: StoredEntity, id: string): NotFoundError => ({
  code: 'not_found',
  message: `${entity} ${id} not found`,
});

export const versionConflict = (entity: StoredEntity, id: string): VersionConflictError => ({
  code: 'version_conflict',
  message: `${entity} ${id} was modified concurrently`,
});

export const nameTaken = (
  entity: 'group' | 'user' | 'connection',
  name: string,
): ConflictError => ({
  code: 'conflict',
  message: `A ${entity} named "${name}" already exists`,
});

export const connectionInUse = (key: string, jobIds: readonly string[]): ConnectionInUseError => ({
  code: 'connection_in_use',
  message: `Connection ${key} is used by ${jobIds.length} job${jobIds.length === 1 ? '' : 's'}`,
  jobIds,
});

export const setupAlreadyCompleted = (): ConflictError => ({
  code: 'conflict',
  message: 'Setup has already been completed',
});

export const authSettingsConflict = (): VersionConflictError => ({
  code: 'version_conflict',
  message: 'Sign-in settings were modified concurrently',
});

export const apiKeyExists = (): ConflictError => ({
  code: 'conflict',
  message: 'That API key already exists',
});

export const duplicateRun = (run: {
  readonly id: string;
  readonly idempotencyKey: string | null;
}): DomainError<'duplicate_run'> => ({
  code: 'duplicate_run',
  message: `Run with key ${run.idempotencyKey ?? run.id} exists`,
});

export const staleRun = (id: string): StaleRunError => ({
  code: 'stale_run',
  message: `Run ${id} changed since it was read`,
});

export const bufferFull = (jobId: string): DomainError<'buffer_full'> => ({
  code: 'buffer_full',
  message: `Job ${jobId} already has a buffered run`,
});

export const staleClaim = (jobId: string): StaleClaimError => ({
  code: 'stale_claim',
  message: `Lost the scheduler claim on job ${jobId}`,
});

export const duplicateWorkflowRun = (run: {
  readonly id: string;
  readonly idempotencyKey: string | null;
}): DomainError<'duplicate_run'> => ({
  code: 'duplicate_run',
  message: `Workflow run ${run.idempotencyKey ?? run.id} exists`,
});

export const staleWorkflowRun = (id: string): DomainError<'stale_run'> => ({
  code: 'stale_run',
  message: `Workflow run ${id} changed concurrently`,
});
