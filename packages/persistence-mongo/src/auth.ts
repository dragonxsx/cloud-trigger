import {
  type ApiKey,
  ApiKey as ApiKeySchema,
  type ApiKeyId,
  type ApiKeyRepository,
  type AuthSettings,
  AuthSettings as AuthSettingsSchema,
  type AuthSettingsStore,
  type ConflictError,
  type NotFoundError,
  type Page,
  type Result,
  type User,
  type UserId,
  type UserQuery,
  type UserRepository,
  User as UserSchema,
  type VersionConflictError,
  err,
  ok,
} from '@cloud-trigger/core';
import type { Collection, Filter } from 'mongodb';

import { findNewestFirstPage } from './cursor.js';
import { isDuplicateKeyError } from './errors.js';

const SETTINGS_ID = 'auth';

export type AuthSettingsDocument = AuthSettings & { _id: string };

export class MongoAuthSettingsStore implements AuthSettingsStore {
  static readonly collectionName = 'auth_settings';

  constructor(private readonly settings: Collection<AuthSettingsDocument>) {}

  async get(): Promise<AuthSettings | undefined> {
    const doc = await this.settings.findOne({ _id: SETTINGS_ID });
    if (!doc) {
      return undefined;
    }
    const { _id, ...rest } = doc;

    return AuthSettingsSchema.parse(rest);
  }

  async create(settings: AuthSettings): Promise<Result<AuthSettings, ConflictError>> {
    try {
      await this.settings.insertOne({ ...settings, _id: SETTINGS_ID });

      return ok(settings);
    } catch (error: unknown) {
      if (isDuplicateKeyError(error)) {
        return err({ code: 'conflict', message: 'Setup has already been completed' });
      }
      throw error;
    }
  }

  async update(
    next: AuthSettings,
    expectedVersion: number,
  ): Promise<Result<AuthSettings, VersionConflictError>> {
    const res = await this.settings.replaceOne(
      { _id: SETTINGS_ID, version: expectedVersion },
      next,
    );

    return res.matchedCount === 1
      ? ok(next)
      : err({ code: 'version_conflict', message: 'Sign-in settings were modified concurrently' });
  }
}

export type UserDocument = Omit<User, 'id'> & { _id: string; usernameLower: string };

const userFromDocument = (doc: UserDocument): User => {
  const { _id, usernameLower: _usernameLower, ...rest } = doc;

  return UserSchema.parse({ ...rest, id: _id });
};

const userFields = (user: User): Omit<UserDocument, '_id'> => {
  const { id: _id, ...rest } = user;

  return { ...rest, usernameLower: user.username.toLowerCase() };
};

export class MongoUserRepository implements UserRepository {
  static readonly collectionName = 'users';

  constructor(private readonly users: Collection<UserDocument>) {}

  static async ensureIndexes(users: Collection<UserDocument>): Promise<void> {
    await users.createIndexes([{ key: { usernameLower: 1 }, name: 'username', unique: true }]);
  }

  async insert(user: User): Promise<Result<User, ConflictError>> {
    try {
      await this.users.insertOne({ ...userFields(user), _id: user.id });

      return ok(user);
    } catch (error: unknown) {
      if (isDuplicateKeyError(error)) {
        return err({ code: 'conflict', message: `A user named "${user.username}" already exists` });
      }
      throw error;
    }
  }

  async get(id: UserId): Promise<User | undefined> {
    const doc = await this.users.findOne({ _id: id });

    return doc ? userFromDocument(doc) : undefined;
  }

  async findByUsername(username: string): Promise<User | undefined> {
    const doc = await this.users.findOne({ usernameLower: username.toLowerCase() });

    return doc ? userFromDocument(doc) : undefined;
  }

  list(query: UserQuery): Promise<Page<User>> {
    const filter: Filter<UserDocument> = query.search
      ? { usernameLower: { $regex: RegExp.escape(query.search.toLowerCase()) } }
      : {};

    return findNewestFirstPage(this.users, filter, query, userFromDocument);
  }

  async update(
    next: User,
    expectedVersion: number,
  ): Promise<Result<User, VersionConflictError | NotFoundError>> {
    const res = await this.users.replaceOne(
      { _id: next.id, version: expectedVersion },
      userFields(next),
    );
    if (res.matchedCount === 1) {
      return ok(next);
    }
    const exists = await this.users.countDocuments({ _id: next.id }, { limit: 1 });

    return exists
      ? err({ code: 'version_conflict', message: `User ${next.id} was modified concurrently` })
      : err({ code: 'not_found', message: `User ${next.id} not found` });
  }

  async delete(id: UserId): Promise<boolean> {
    return (await this.users.deleteOne({ _id: id })).deletedCount === 1;
  }

  countActiveAdmins(): Promise<number> {
    return this.users.countDocuments({ disabled: false, scopes: 'admin' });
  }
}

export type ApiKeyDocument = Omit<ApiKey, 'id'> & { _id: string };

const apiKeyFromDocument = (doc: ApiKeyDocument): ApiKey => {
  const { _id, ...rest } = doc;

  return ApiKeySchema.parse({ ...rest, id: _id });
};

export class MongoApiKeyRepository implements ApiKeyRepository {
  static readonly collectionName = 'api_keys';

  constructor(private readonly keys: Collection<ApiKeyDocument>) {}

  static async ensureIndexes(keys: Collection<ApiKeyDocument>): Promise<void> {
    await keys.createIndexes([{ key: { hash: 1 }, name: 'hash', unique: true }]);
  }

  async insert(key: ApiKey): Promise<Result<ApiKey, ConflictError>> {
    const { id, ...rest } = key;
    try {
      await this.keys.insertOne({ ...rest, _id: id });

      return ok(key);
    } catch (error: unknown) {
      if (isDuplicateKeyError(error)) {
        return err({ code: 'conflict', message: 'That API key already exists' });
      }
      throw error;
    }
  }

  async findByHash(hash: string): Promise<ApiKey | undefined> {
    const doc = await this.keys.findOne({ hash });

    return doc ? apiKeyFromDocument(doc) : undefined;
  }

  async list(): Promise<readonly ApiKey[]> {
    const docs = await this.keys.find({}).sort({ createdAt: -1, _id: -1 }).toArray();

    return docs.map(apiKeyFromDocument);
  }

  async revoke(id: ApiKeyId, at: Date): Promise<boolean> {
    const res = await this.keys.updateOne(
      { _id: id, revokedAt: { $exists: false } },
      { $set: { revokedAt: at } },
    );

    return res.matchedCount === 1;
  }

  async touch(id: ApiKeyId, at: Date): Promise<void> {
    await this.keys.updateOne({ _id: id }, { $set: { lastUsedAt: at } });
  }
}
