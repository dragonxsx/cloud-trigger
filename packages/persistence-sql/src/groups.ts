import {
  type AcquireResult,
  type ConflictError,
  DEFAULT_CONCURRENCY_RETRY_MS,
  Group,
  type GroupId,
  type GroupQuery,
  type GroupRepository,
  type GroupSpec,
  type NotFoundError,
  type RateLimit,
  type RateLimiter,
  type Result,
  type VersionConflictError,
  acquireResult,
  attemptAcquire,
  err,
  groupUpdateFields,
  nameTaken,
  notFound,
  ok,
  versionConflict,
} from '@cloud-trigger/core';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { Epoch, docParser } from './codec.js';
import { and, containsInsensitive, newestFirstPage } from './query.js';
import { assignments, insertInto, rowParser } from './rows.js';
import type { SqlSession } from './session.js';

const groupFromRow = docParser(Group);

export class SqlGroupRepository implements GroupRepository {
  constructor(private readonly session: SqlSession) {}

  async insert(group: Group): Promise<Result<Group, ConflictError>> {
    const inserted = await this.session.run(
      sql`${insertInto(this.session, 'groups', {
        id: group.id,
        name: group.name,
        version: group.version,
        created_at: group.createdAt,
        doc: group,
      })} ON CONFLICT DO NOTHING`,
    );

    return inserted === 1 ? ok(group) : err(nameTaken('group', group.name));
  }

  async get(id: GroupId): Promise<Group | undefined> {
    const [row] = await this.session.all(sql`SELECT doc FROM groups WHERE id = ${id}`);

    return row ? groupFromRow(row) : undefined;
  }

  async findByName(name: string): Promise<Group | undefined> {
    const [row] = await this.session.all(
      sql`SELECT doc FROM groups WHERE lower(name) = lower(${name})`,
    );

    return row ? groupFromRow(row) : undefined;
  }

  list(query: GroupQuery) {
    const where = and([containsInsensitive(this.session.dialect, 'name', query.search)]);

    return newestFirstPage(this.session, sql`groups`, where, query, groupFromRow);
  }

  async update(
    id: GroupId,
    update: { spec: GroupSpec; updatedAt: Date },
    expectedVersion: number,
  ): Promise<Result<Group, VersionConflictError | NotFoundError | ConflictError>> {
    const current = await this.get(id);
    if (!current) {
      return err(notFound('Group', id));
    }
    const next = Group.parse({ ...current, ...groupUpdateFields(update, expectedVersion) });
    const clash = await this.findByName(next.name);
    if (clash && clash.id !== id) {
      return err(nameTaken('group', next.name));
    }
    try {
      const changed = await this.session.run(sql`
        UPDATE groups SET ${assignments(this.session, 'groups', {
          name: next.name,
          version: next.version,
          doc: next,
        })}
        WHERE id = ${id} AND version = ${expectedVersion}`);

      return changed === 1 ? ok(next) : err(versionConflict('Group', id));
    } catch (error: unknown) {
      if (this.session.dialect.isUniqueViolation(error)) {
        return err(nameTaken('group', next.name));
      }
      throw error;
    }
  }

  async delete(id: GroupId): Promise<boolean> {
    return (await this.session.run(sql`DELETE FROM groups WHERE id = ${id}`)) === 1;
  }
}

const parseLimitRow = rowParser('rate_limits');

export class SqlRateLimiter implements RateLimiter {
  constructor(
    private readonly session: SqlSession,
    private readonly concurrencyRetryMs = DEFAULT_CONCURRENCY_RETRY_MS,
  ) {}

  tryAcquire(key: string, limit: RateLimit, now: Date): Promise<AcquireResult> {
    return this.session.transaction(async () => {
      await this.session.run(
        sql`${insertInto(this.session, 'rate_limits', {
          key,
          tokens: null,
          refilled_at: null,
          running: 0,
          touched_at: null,
        })} ON CONFLICT DO NOTHING`,
      );
      const [row] = await this.session.all(
        sql`SELECT * FROM rate_limits WHERE key = ${key} ${this.session.dialect.forUpdate}`,
      );
      if (!row) {
        throw new Error(`Rate limit ${key} was not created`);
      }
      const state = parseLimitRow(row);
      const attempt = attemptAcquire(
        limit,
        { running: state.running, tokens: state.tokens, refilledAt: state.refilled_at },
        now,
      );
      await this.session.run(sql`
        UPDATE rate_limits SET ${assignments(this.session, 'rate_limits', {
          running: attempt.running,
          tokens: attempt.tokens,
          refilled_at: now,
          touched_at: attempt.granted ? now : state.touched_at,
        })}
        WHERE key = ${key}`);

      return acquireResult(limit, attempt, now, this.concurrencyRetryMs);
    });
  }

  async release(key: string, now: Date): Promise<void> {
    await this.session.run(sql`
      UPDATE rate_limits SET running = CASE WHEN running > 0 THEN running - 1 ELSE 0 END,
        touched_at = ${now.getTime()}
      WHERE key = ${key}`);
  }

  async reconcile(key: string, p: { running: number; idleSince: Date }): Promise<boolean> {
    const changed = await this.session.run(sql`
      UPDATE rate_limits SET running = ${p.running}
      WHERE key = ${key} AND touched_at < ${p.idleSince.getTime()} AND running <> ${p.running}`);

    return changed === 1;
  }

  async listHeld(): Promise<readonly { key: string; running: number }[]> {
    const rows = await this.session.all(
      sql`SELECT key, running FROM rate_limits WHERE running > 0`,
    );

    return rows.map((row) => {
      const held = z.object({ key: z.string(), running: Epoch }).parse(row);

      return { key: held.key, running: held.running };
    });
  }
}
