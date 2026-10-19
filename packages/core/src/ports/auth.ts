import type { Result } from 'neverthrow';

import type { ApiKey, AuthSettings, User } from '../domain/auth.js';
import type { ApiKeyId, UserId } from '../domain/ids.js';
import type { NotFoundError, VersionConflictError } from '../shared/errors.js';
import type { Page, PageRequest } from './common.js';
import type { ConflictError } from './groups.js';

export interface AuthSettingsStore {
  get(): Promise<AuthSettings | undefined>;
  create(settings: AuthSettings): Promise<Result<AuthSettings, ConflictError>>;
  update(
    next: AuthSettings,
    expectedVersion: number,
  ): Promise<Result<AuthSettings, VersionConflictError>>;
}

export interface UserQuery extends PageRequest {
  readonly search?: string | undefined;
}

export interface UserRepository {
  insert(user: User): Promise<Result<User, ConflictError>>;
  get(id: UserId): Promise<User | undefined>;
  findByUsername(username: string): Promise<User | undefined>;
  list(query: UserQuery): Promise<Page<User>>;
  update(
    next: User,
    expectedVersion: number,
  ): Promise<Result<User, VersionConflictError | NotFoundError>>;
  delete(id: UserId): Promise<boolean>;
  countActiveAdmins(): Promise<number>;
}

export interface ApiKeyRepository {
  insert(key: ApiKey): Promise<Result<ApiKey, ConflictError>>;
  findByHash(hash: string): Promise<ApiKey | undefined>;
  list(): Promise<readonly ApiKey[]>;
  revoke(id: ApiKeyId, at: Date): Promise<boolean>;
  touch(id: ApiKeyId, at: Date): Promise<void>;
}

export interface PasswordHasher {
  readonly hash: (password: string) => Promise<string>;
  readonly verify: (hash: string, password: string) => Promise<boolean>;
}
