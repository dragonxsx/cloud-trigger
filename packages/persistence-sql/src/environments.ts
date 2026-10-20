import {
  type ConflictError,
  Environment,
  type EnvironmentQuery,
  type EnvironmentRepository,
  type EnvironmentSpec,
  type NotFoundError,
  type Page,
  type Result,
  type VersionConflictError,
  environmentUpdateFields,
  err,
  nameTaken,
  notFound,
  ok,
  versionConflict,
} from '@cloud-trigger/core';
import { sql } from 'drizzle-orm';

import { Count, docParser } from './codec.js';
import { and, containsInsensitive } from './query.js';
import { assignments, insertInto } from './rows.js';
import type { SqlSession } from './session.js';

const environmentFromRow = docParser(Environment);

export class SqlEnvironmentRepository implements EnvironmentRepository {
  constructor(private readonly session: SqlSession) {}

  async insert(environment: Environment): Promise<Result<Environment, ConflictError>> {
    const inserted = await this.session.run(
      sql`${insertInto(this.session, 'environments', {
        id: environment.id,
        key: environment.key,
        name: environment.name,
        version: environment.version,
        created_at: environment.createdAt,
        doc: environment,
      })} ON CONFLICT DO NOTHING`,
    );

    return inserted === 1 ? ok(environment) : err(nameTaken('environment', environment.key));
  }

  async get(key: string): Promise<Environment | undefined> {
    const [row] = await this.session.all(sql`SELECT doc FROM environments WHERE key = ${key}`);

    return row ? environmentFromRow(row) : undefined;
  }

  async list(query: EnvironmentQuery): Promise<Page<Environment>> {
    const { dialect } = this.session;
    const where = and([
      query.search
        ? sql`(${containsInsensitive(dialect, 'key', query.search)} OR ${containsInsensitive(dialect, 'name', query.search)})`
        : undefined,
    ]);
    const pageWhere = query.cursor ? and([where, sql`key > ${query.cursor}`]) : where;
    const offset = query.cursor ? 0 : (query.offset ?? 0);
    const [rows, counted] = await Promise.all([
      this.session.all(
        sql`SELECT doc FROM environments WHERE ${pageWhere} ORDER BY key LIMIT ${query.limit + 1} OFFSET ${offset}`,
      ),
      this.session.all(sql`SELECT count(*) AS count FROM environments WHERE ${where}`),
    ]);
    const items = rows.slice(0, query.limit).map(environmentFromRow);

    return {
      items,
      nextCursor: rows.length > query.limit ? (items.at(-1)?.key ?? null) : null,
      total: Count.parse(counted[0]).count,
    };
  }

  async update(
    key: string,
    update: { spec: EnvironmentSpec; updatedAt: Date },
    expectedVersion: number,
  ): Promise<Result<Environment, VersionConflictError | NotFoundError>> {
    const current = await this.get(key);
    if (!current) {
      return err(notFound('Environment', key));
    }
    const next = Environment.parse({
      ...current,
      ...environmentUpdateFields(update, expectedVersion),
      key,
    });
    const changed = await this.session.run(sql`
      UPDATE environments SET ${assignments(this.session, 'environments', {
        name: next.name,
        version: next.version,
        doc: next,
      })}
      WHERE key = ${key} AND version = ${expectedVersion}`);

    return changed === 1 ? ok(next) : err(versionConflict('Environment', key));
  }

  async delete(key: string): Promise<boolean> {
    return (await this.session.run(sql`DELETE FROM environments WHERE key = ${key}`)) === 1;
  }
}
