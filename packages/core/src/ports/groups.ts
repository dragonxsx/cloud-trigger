import type { Result } from 'neverthrow';

import type { ConnectionRef } from '../domain/connection.js';
import type { Group, GroupSpec, RateLimit } from '../domain/group.js';
import type { GroupId } from '../domain/ids.js';
import type { DomainError, NotFoundError, VersionConflictError } from '../shared/errors.js';
import type { Page, PageRequest } from './common.js';

export type ConflictError = DomainError<'conflict'>;

export interface GroupQuery extends PageRequest {
  readonly search?: string | undefined;
}

export interface GroupUpdate {
  readonly spec: GroupSpec;
  readonly connectionRefs?: readonly ConnectionRef[] | undefined;
  readonly updatedAt: Date;
}

export interface GroupRepository {
  insert(group: Group): Promise<Result<Group, ConflictError>>;
  get(id: GroupId): Promise<Group | undefined>;
  findByName(name: string): Promise<Group | undefined>;
  list(query: GroupQuery): Promise<Page<Group>>;
  update(
    id: GroupId,
    update: GroupUpdate,
    expectedVersion: number,
  ): Promise<Result<Group, VersionConflictError | NotFoundError | ConflictError>>;
  delete(id: GroupId): Promise<boolean>;
  findByConnection(key: string, endpoint?: string): Promise<readonly Group[]>;
  findByEnvironment(environment: string): Promise<readonly Group[]>;
}

export type AcquireResult =
  | { readonly ok: true; readonly holdsSlot: boolean }
  | { readonly ok: false; readonly retryAt: Date };

export interface RateLimiter {
  tryAcquire(key: string, limit: RateLimit, now: Date): Promise<AcquireResult>;
  release(key: string, now: Date): Promise<void>;
  reconcile(key: string, p: { running: number; idleSince: Date }): Promise<boolean>;
  listHeld(): Promise<readonly { key: string; running: number }[]>;
}
