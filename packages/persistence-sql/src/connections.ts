import {
  type ConflictError,
  Connection,
  type ConnectionQuery,
  type ConnectionRepository,
  type ConnectionSpec,
  type NotFoundError,
  type Page,
  type Result,
  type VersionConflictError,
  connectionUpdateFields,
  err,
  nameTaken,
  notFound,
  ok,
  versionConflict,
} from '@cloud-trigger/core';
import { sql } from 'drizzle-orm';

import { Count, docParser } from './codec.js';
import { and, containsInsensitive, inList } from './query.js';
import { assignments, insertInto } from './rows.js';
import type { SqlSession } from './session.js';

const connectionFromRow = docParser(Connection);

export class SqlConnectionRepository implements ConnectionRepository {
  constructor(private readonly session: SqlSession) {}

  async #writeEnvironments(connection: Pick<Connection, 'key' | 'overlays'>): Promise<void> {
    await this.session.run(
      sql`DELETE FROM connection_environments WHERE connection_key = ${connection.key}`,
    );
    for (const environment of new Set(connection.overlays.map((overlay) => overlay.environment))) {
      await this.session.run(
        insertInto(this.session, 'connection_environments', {
          connection_key: connection.key,
          environment,
        }),
      );
    }
  }

  insert(connection: Connection): Promise<Result<Connection, ConflictError>> {
    return this.session.transaction(async () => {
      const inserted = await this.session.run(
        sql`${insertInto(this.session, 'connections', {
          id: connection.id,
          key: connection.key,
          name: connection.name,
          type: connection.type,
          version: connection.version,
          created_at: connection.createdAt,
          doc: connection,
        })} ON CONFLICT DO NOTHING`,
      );
      if (inserted !== 1) {
        return err(nameTaken('connection', connection.key));
      }
      await this.#writeEnvironments(connection);

      return ok(connection);
    });
  }

  async get(key: string): Promise<Connection | undefined> {
    const [row] = await this.session.all(sql`SELECT doc FROM connections WHERE key = ${key}`);

    return row ? connectionFromRow(row) : undefined;
  }

  async getMany(keys: readonly string[]): Promise<readonly Connection[]> {
    if (keys.length === 0) {
      return [];
    }
    const rows = await this.session.all(
      sql`SELECT doc FROM connections WHERE key IN (${inList(keys)})`,
    );

    return rows.map(connectionFromRow);
  }

  async list(query: ConnectionQuery): Promise<Page<Connection>> {
    const { dialect } = this.session;
    const search = query.search
      ? sql`(${containsInsensitive(dialect, 'key', query.search)} OR ${containsInsensitive(dialect, 'name', query.search)})`
      : undefined;
    const where = and([search, query.type ? sql`type = ${query.type}` : undefined]);
    const pageWhere = query.cursor ? and([where, sql`key > ${query.cursor}`]) : where;
    const offset = query.cursor ? 0 : (query.offset ?? 0);
    const [rows, counted] = await Promise.all([
      this.session.all(
        sql`SELECT doc FROM connections WHERE ${pageWhere} ORDER BY key LIMIT ${query.limit + 1} OFFSET ${offset}`,
      ),
      this.session.all(sql`SELECT count(*) AS count FROM connections WHERE ${where}`),
    ]);
    const items = rows.slice(0, query.limit).map(connectionFromRow);

    return {
      items,
      nextCursor: rows.length > query.limit ? (items.at(-1)?.key ?? null) : null,
      total: Count.parse(counted[0]).count,
    };
  }

  async update(
    key: string,
    update: { spec: ConnectionSpec; updatedAt: Date },
    expectedVersion: number,
  ): Promise<Result<Connection, VersionConflictError | NotFoundError>> {
    const current = await this.get(key);
    if (!current) {
      return err(notFound('Connection', key));
    }
    const next = Connection.parse({
      ...current,
      ...connectionUpdateFields(update, expectedVersion),
      key,
    });

    return this.session.transaction(async () => {
      const changed = await this.session.run(sql`
        UPDATE connections SET ${assignments(this.session, 'connections', {
          name: next.name,
          type: next.type,
          version: next.version,
          doc: next,
        })}
        WHERE key = ${key} AND version = ${expectedVersion}`);
      if (changed !== 1) {
        return err(versionConflict('Connection', key));
      }
      await this.#writeEnvironments(next);

      return ok(next);
    });
  }

  delete(key: string): Promise<boolean> {
    return this.session.transaction(async () => {
      await this.session.run(
        sql`DELETE FROM connection_environments WHERE connection_key = ${key}`,
      );

      return (await this.session.run(sql`DELETE FROM connections WHERE key = ${key}`)) === 1;
    });
  }

  async findByEnvironment(environment: string): Promise<readonly Connection[]> {
    const rows = await this.session.all(sql`
      SELECT doc FROM connections WHERE key IN (
        SELECT connection_key FROM connection_environments WHERE environment = ${environment}
      ) ORDER BY key`);

    return rows.map(connectionFromRow);
  }
}
