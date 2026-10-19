import {
  AUTH_SETTINGS_ID,
  ApiKey,
  type ApiKeyId,
  type ApiKeyRepository,
  AuthSettings,
  type AuthSettingsStore,
  type ConflictError,
  type NotFoundError,
  type Page,
  type Result,
  User,
  type UserId,
  type UserQuery,
  type UserRepository,
  type VersionConflictError,
  apiKeyExists,
  authSettingsConflict,
  err,
  isActiveAdmin,
  nameTaken,
  normalizeUsername,
  notFound,
  ok,
  setupAlreadyCompleted,
  versionConflict,
} from '@cloud-trigger/core';
import { sql } from 'drizzle-orm';

import { Count, docParser } from './codec.js';
import { likePattern, newestFirstPage } from './query.js';
import { type RowValues, assignments, insertInto } from './rows.js';
import type { SqlSession } from './session.js';

const settingsFromRow = docParser(AuthSettings);
const userFromRow = docParser(User);
const apiKeyFromRow = docParser(ApiKey);

const userColumns = (user: User): RowValues<'users'> => ({
  id: user.id,
  username_lower: normalizeUsername(user.username),
  active_admin: isActiveAdmin(user),
  version: user.version,
  doc: user,
});

export class SqlAuthSettingsStore implements AuthSettingsStore {
  constructor(private readonly session: SqlSession) {}

  async get(): Promise<AuthSettings | undefined> {
    const [row] = await this.session.all(
      sql`SELECT doc FROM auth_settings WHERE id = ${AUTH_SETTINGS_ID}`,
    );

    return row ? settingsFromRow(row) : undefined;
  }

  async create(settings: AuthSettings): Promise<Result<AuthSettings, ConflictError>> {
    const inserted = await this.session.run(
      sql`${insertInto(this.session, 'auth_settings', {
        id: AUTH_SETTINGS_ID,
        version: settings.version,
        doc: settings,
      })} ON CONFLICT DO NOTHING`,
    );

    return inserted === 1 ? ok(settings) : err(setupAlreadyCompleted());
  }

  async update(
    next: AuthSettings,
    expectedVersion: number,
  ): Promise<Result<AuthSettings, VersionConflictError>> {
    const changed = await this.session.run(sql`
      UPDATE auth_settings SET ${assignments(this.session, 'auth_settings', {
        version: next.version,
        doc: next,
      })}
      WHERE id = ${AUTH_SETTINGS_ID} AND version = ${expectedVersion}`);

    return changed === 1 ? ok(next) : err(authSettingsConflict());
  }
}

export class SqlUserRepository implements UserRepository {
  constructor(private readonly session: SqlSession) {}

  async insert(user: User): Promise<Result<User, ConflictError>> {
    const inserted = await this.session.run(
      sql`${insertInto(this.session, 'users', userColumns(user))} ON CONFLICT DO NOTHING`,
    );

    return inserted === 1 ? ok(user) : err(nameTaken('user', user.username));
  }

  async get(id: UserId): Promise<User | undefined> {
    const [row] = await this.session.all(sql`SELECT doc FROM users WHERE id = ${id}`);

    return row ? userFromRow(row) : undefined;
  }

  async findByUsername(username: string): Promise<User | undefined> {
    const [row] = await this.session.all(
      sql`SELECT doc FROM users WHERE username_lower = ${normalizeUsername(username)}`,
    );

    return row ? userFromRow(row) : undefined;
  }

  list(query: UserQuery): Promise<Page<User>> {
    const where = query.search
      ? sql`username_lower LIKE ${likePattern(normalizeUsername(query.search))} ESCAPE '\\'`
      : sql`1 = 1`;

    return newestFirstPage(this.session, sql`users`, where, query, userFromRow);
  }

  async update(
    next: User,
    expectedVersion: number,
  ): Promise<Result<User, VersionConflictError | NotFoundError>> {
    const { id: _id, ...changes } = userColumns(next);
    const changed = await this.session.run(sql`
      UPDATE users SET ${assignments(this.session, 'users', changes)}
      WHERE id = ${next.id} AND version = ${expectedVersion}`);
    if (changed === 1) {
      return ok(next);
    }

    return (await this.get(next.id))
      ? err(versionConflict('User', next.id))
      : err(notFound('User', next.id));
  }

  async delete(id: UserId): Promise<boolean> {
    return (await this.session.run(sql`DELETE FROM users WHERE id = ${id}`)) === 1;
  }

  async countActiveAdmins(): Promise<number> {
    const rows = await this.session.all(
      sql`SELECT count(*) AS count FROM users WHERE active_admin = 1`,
    );

    return Count.parse(rows[0]).count;
  }
}

export class SqlApiKeyRepository implements ApiKeyRepository {
  constructor(private readonly session: SqlSession) {}

  async insert(key: ApiKey): Promise<Result<ApiKey, ConflictError>> {
    const inserted = await this.session.run(
      sql`${insertInto(this.session, 'api_keys', {
        id: key.id,
        hash: key.hash,
        doc: key,
      })} ON CONFLICT DO NOTHING`,
    );

    return inserted === 1 ? ok(key) : err(apiKeyExists());
  }

  async findByHash(hash: string): Promise<ApiKey | undefined> {
    const [row] = await this.session.all(sql`SELECT doc FROM api_keys WHERE hash = ${hash}`);

    return row ? apiKeyFromRow(row) : undefined;
  }

  async list(): Promise<readonly ApiKey[]> {
    const rows = await this.session.all(sql`SELECT doc FROM api_keys ORDER BY id DESC`);

    return rows.map(apiKeyFromRow);
  }

  revoke(id: ApiKeyId, at: Date): Promise<boolean> {
    return this.#patch(id, (key) =>
      key.revokedAt === undefined ? { ...key, revokedAt: at } : undefined,
    );
  }

  async touch(id: ApiKeyId, at: Date): Promise<void> {
    await this.#patch(id, (key) => ({ ...key, lastUsedAt: at }));
  }

  #patch(id: ApiKeyId, change: (key: ApiKey) => ApiKey | undefined): Promise<boolean> {
    return this.session.transaction(async () => {
      const [row] = await this.session.all(
        sql`SELECT doc FROM api_keys WHERE id = ${id} ${this.session.dialect.forUpdate}`,
      );
      const next = row ? change(apiKeyFromRow(row)) : undefined;
      if (!next) {
        return false;
      }
      await this.session.run(sql`
        UPDATE api_keys SET ${assignments(this.session, 'api_keys', { doc: next })}
        WHERE id = ${id}`);

      return true;
    });
  }
}
