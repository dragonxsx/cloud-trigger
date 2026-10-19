import {
  AUTH_SETTINGS_ID,
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
  apiKeyExists,
  authSettingsConflict,
  err,
  nameTaken,
  normalizeUsername,
  ok,
  setupAlreadyCompleted,
} from '@cloud-trigger/core';
import type { Collection, Filter } from 'mongodb';

import { findNewestFirstPage } from './cursor.js';
import { type Stored, documentParser, toDocument } from './documents.js';
import { casMissed, unlessDuplicateKey } from './errors.js';

export type AuthSettingsDocument = AuthSettings & { _id: string };

export class MongoAuthSettingsStore implements AuthSettingsStore {
  static readonly collectionName = 'auth_settings';

  constructor(private readonly settings: Collection<AuthSettingsDocument>) {}

  async get(): Promise<AuthSettings | undefined> {
    const doc = await this.settings.findOne({ _id: AUTH_SETTINGS_ID });

    return doc ? AuthSettingsSchema.parse(doc) : undefined;
  }

  async create(settings: AuthSettings): Promise<Result<AuthSettings, ConflictError>> {
    const inserted = await unlessDuplicateKey(
      () => this.settings.insertOne({ ...settings, _id: AUTH_SETTINGS_ID }),
      setupAlreadyCompleted,
    );

    return inserted.map(() => settings);
  }

  async update(
    next: AuthSettings,
    expectedVersion: number,
  ): Promise<Result<AuthSettings, VersionConflictError>> {
    const res = await this.settings.replaceOne(
      { _id: AUTH_SETTINGS_ID, version: expectedVersion },
      next,
    );

    return res.matchedCount === 1 ? ok(next) : err(authSettingsConflict());
  }
}

export type UserDocument = Stored<User> & { usernameLower: string };

const userFromDocument = documentParser(UserSchema);

const toUserDocument = (user: User): UserDocument => ({
  ...toDocument(user),
  usernameLower: normalizeUsername(user.username),
});

export class MongoUserRepository implements UserRepository {
  static readonly collectionName = 'users';

  constructor(private readonly users: Collection<UserDocument>) {}

  static async ensureIndexes(users: Collection<UserDocument>): Promise<void> {
    await users.createIndexes([{ key: { usernameLower: 1 }, name: 'username', unique: true }]);
  }

  async insert(user: User): Promise<Result<User, ConflictError>> {
    const inserted = await unlessDuplicateKey(
      () => this.users.insertOne(toUserDocument(user)),
      () => nameTaken('user', user.username),
    );

    return inserted.map(() => user);
  }

  async get(id: UserId): Promise<User | undefined> {
    const doc = await this.users.findOne({ _id: id });

    return doc ? userFromDocument(doc) : undefined;
  }

  async findByUsername(username: string): Promise<User | undefined> {
    const doc = await this.users.findOne({ usernameLower: normalizeUsername(username) });

    return doc ? userFromDocument(doc) : undefined;
  }

  list(query: UserQuery): Promise<Page<User>> {
    const filter: Filter<UserDocument> = query.search
      ? { usernameLower: { $regex: RegExp.escape(normalizeUsername(query.search)) } }
      : {};

    return findNewestFirstPage(this.users, filter, query, userFromDocument);
  }

  async update(
    next: User,
    expectedVersion: number,
  ): Promise<Result<User, VersionConflictError | NotFoundError>> {
    const res = await this.users.replaceOne(
      { _id: next.id, version: expectedVersion },
      toUserDocument(next),
    );

    return res.matchedCount === 1 ? ok(next) : casMissed(this.users, 'User', next.id);
  }

  async delete(id: UserId): Promise<boolean> {
    return (await this.users.deleteOne({ _id: id })).deletedCount === 1;
  }

  countActiveAdmins(): Promise<number> {
    return this.users.countDocuments({ disabled: false, scopes: 'admin' });
  }
}

export type ApiKeyDocument = Stored<ApiKey>;

const apiKeyFromDocument = documentParser(ApiKeySchema);

export class MongoApiKeyRepository implements ApiKeyRepository {
  static readonly collectionName = 'api_keys';

  constructor(private readonly keys: Collection<ApiKeyDocument>) {}

  static async ensureIndexes(keys: Collection<ApiKeyDocument>): Promise<void> {
    await keys.createIndexes([{ key: { hash: 1 }, name: 'hash', unique: true }]);
  }

  async insert(key: ApiKey): Promise<Result<ApiKey, ConflictError>> {
    const inserted = await unlessDuplicateKey(
      () => this.keys.insertOne(toDocument(key)),
      apiKeyExists,
    );

    return inserted.map(() => key);
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
