import type { Result } from 'neverthrow';

import type { Environment, EnvironmentSpec } from '../domain/environment.js';
import type { DomainError, NotFoundError, VersionConflictError } from '../shared/errors.js';
import type { Page, PageRequest } from './common.js';
import type { ConflictError } from './groups.js';

export interface EnvironmentInUseError extends DomainError<'environment_in_use'> {
  readonly jobIds: readonly string[];
  readonly groupIds: readonly string[];
  readonly workflowIds: readonly string[];
  readonly connectionKeys: readonly string[];
}

export interface EnvironmentQuery extends PageRequest {
  readonly search?: string | undefined;
}

export interface EnvironmentRepository {
  insert(environment: Environment): Promise<Result<Environment, ConflictError>>;
  get(key: string): Promise<Environment | undefined>;
  list(query: EnvironmentQuery): Promise<Page<Environment>>;
  update(
    key: string,
    update: { spec: EnvironmentSpec; updatedAt: Date },
    expectedVersion: number,
  ): Promise<Result<Environment, VersionConflictError | NotFoundError>>;
  delete(key: string): Promise<boolean>;
}
