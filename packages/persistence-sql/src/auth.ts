import {
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
  err,
  isActiveAdmin,
  ok,
} from '@cloud-trigger/core';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { Count, decodeDoc, encodeDoc, flag } from './codec.js';
import { likePattern, newestFirstPage } from './query.js';
import type { Row, SqlSession } from './session.js';

const SETTINGS_ID = 'auth';
const DocRow = z.looseObject({ doc: z.unknown() });
const docOf = (row: Row): unknown => decodeDoc(DocRow.parse(row).doc);

export class SqlAuthSettingsStore implements AuthSettingsStore {
  constructor(private readonly session: SqlSession) {}

  async get(): Promise<AuthSettings | undefined> {
    const [row] = await this.session.all(
      sql`SELECT doc FROM auth_settings WHERE id = ${SETTINGS_ID}`,
    );

    return row ? AuthSettings.parse(docOf(row)) : undefined;
  }

  async create(settings: AuthSettings): Promise<Result<AuthSettings, ConflictError>> {
    const inserted = await this.session.run(sql`
      INSERT INTO auth_settings (id, version, doc)
      VALUES (${SETTINGS_ID}, ${settings.version}, ${this.session.dialect.json(encodeDoc(settings))})
      ON CONFLICT DO NOTHING`);

    return inserted === 1
      ? ok(settings)
      : err({ code: 'conflict', message: 'Setup has already been completed' });
  }

  async update(
    next: AuthSettings,
    expectedVersion: number,
  ): Promise<Result<AuthSettings, VersionConflictError>> {
    const changed = await this.session.run(sql`
      UPDATE auth_settings SET version = ${next.version},
        doc = ${this.session.dialect.json(encodeDoc(next))}
      WHERE id = ${SETTINGS_ID} AND version = ${expectedVersion}`);

    return changed === 1
      ? ok(next)
      : err({ code: 'version_conflict', message: 'Sign-in settings were modified concurrently' });
  }
}

const userFromRow = (row: Row): User => User.parse(docOf(row));

export class SqlUserRepository implements UserRepository {
  constructor(private readonly session: SqlSession) {}

  async insert(user: User): Promise<Result<User, ConflictError>> {
    const inserted = await this.session.run(sql`
      INSERT INTO users (id, username_lower, active_admin, version, doc)
      VALUES (${user.id}, ${user.username.toLowerCase()}, ${flag(isActiveAdmin(user))},
        ${user.version}, ${this.session.dialect.json(encodeDoc(user))})
      ON CONFLICT DO NOTHING`);

    return inserted === 1
      ? ok(user)
      : err({ code: 'conflict', message: `A user named "${user.username}" already exists` });
  }

  async get(id: UserId): Promise<User | undefined> {
    const [row] = await this.session.all(sql`SELECT doc FROM users WHERE id = ${id}`);

    return row ? userFromRow(row) : undefined;
  }

  async findByUsername(username: string): Promise<User | undefined> {
    const [row] = await this.session.all(
      sql`SELECT doc FROM users WHERE username_lower = ${username.toLowerCase()}`,
    );

    return row ? userFromRow(row) : undefined;
  }

  list(query: UserQuery): Promise<Page<User>> {
    const where = query.search
      ? sql`username_lower LIKE ${likePattern(query.search.toLowerCase())} ESCAPE '\\'`
      : sql`1 = 1`;

    return newestFirstPage(this.session, sql`users`, where, query, userFromRow);
  }

  async update(
    next: User,
    expectedVersion: number,
  ): Promise<Result<User, VersionConflictError | NotFoundError>> {
    const changed = await this.session.run(sql`
      UPDATE users SET username_lower = ${next.username.toLowerCase()},
        active_admin = ${flag(isActiveAdmin(next))}, version = ${next.version},
        doc = ${this.session.dialect.json(encodeDoc(next))}
      WHERE id = ${next.id} AND version = ${expectedVersion}`);
    if (changed === 1) {
      return ok(next);
    }

    return (await this.get(next.id))
      ? err({ code: 'version_conflict', message: `User ${next.id} was modified concurrently` })
      : err({ code: 'not_found', message: `User ${next.id} not found` });
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

const apiKeyFromRow = (row: Row): ApiKey => ApiKey.parse(docOf(row));

export class SqlApiKeyRepository implements ApiKeyRepository {
  constructor(private readonly session: SqlSession) {}

  async insert(key: ApiKey): Promise<Result<ApiKey, ConflictError>> {
    const inserted = await this.session.run(sql`
      INSERT INTO api_keys (id, hash, doc)
      VALUES (${key.id}, ${key.hash}, ${this.session.dialect.json(encodeDoc(key))})
      ON CONFLICT DO NOTHING`);

    return inserted === 1
      ? ok(key)
      : err({ code: 'conflict', message: 'That API key already exists' });
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
        UPDATE api_keys SET doc = ${this.session.dialect.json(encodeDoc(next))} WHERE id = ${id}`);

      return true;
    });
  }
}
