import type { Result } from 'neverthrow';

import type { Connection, ConnectionSpec } from '../domain/connection.js';
import type { DomainError, NotFoundError, VersionConflictError } from '../shared/errors.js';
import type { Page, PageRequest } from './common.js';
import type { ConflictError } from './groups.js';

export interface ConnectionInUseError extends DomainError<'connection_in_use'> {
  readonly jobIds: readonly string[];
}

export interface ConnectionQuery extends PageRequest {
  readonly search?: string | undefined;
  readonly type?: string | undefined;
}

export interface ConnectionRepository {
  insert(connection: Connection): Promise<Result<Connection, ConflictError>>;
  get(key: string): Promise<Connection | undefined>;
  getMany(keys: readonly string[]): Promise<readonly Connection[]>;
  list(query: ConnectionQuery): Promise<Page<Connection>>;
  update(
    key: string,
    update: { spec: ConnectionSpec; updatedAt: Date },
    expectedVersion: number,
  ): Promise<Result<Connection, VersionConflictError | NotFoundError>>;
  delete(key: string): Promise<boolean>;
}
