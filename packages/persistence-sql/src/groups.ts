import {
  type AcquireResult,
  type ConflictError,
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
  err,
  ok,
} from '@cloud-trigger/core';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { DateColumn, Epoch, decodeDoc, encodeDoc } from './codec.js';
import { likePattern, newestFirstPage } from './query.js';
import type { Row, SqlSession } from './session.js';

const groupFromRow = (row: Row): Group =>
  Group.parse(decodeDoc(z.looseObject({ doc: z.unknown() }).parse(row).doc));

const nameTaken = (name: string): ConflictError => ({
  code: 'conflict',
  message: `A group named "${name}" already exists`,
});

export class SqlGroupRepository implements GroupRepository {
  constructor(private readonly session: SqlSession) {}

  async insert(group: Group): Promise<Result<Group, ConflictError>> {
    const inserted = await this.session.run(sql`
      INSERT INTO groups (id, name, version, created_at, doc)
      VALUES (${group.id}, ${group.name}, ${group.version}, ${group.createdAt.getTime()},
        ${this.session.dialect.json(encodeDoc(group))})
      ON CONFLICT DO NOTHING`);

    return inserted === 1 ? ok(group) : err(nameTaken(group.name));
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
    const where = query.search
      ? sql`name ${this.session.dialect.caseInsensitiveLike} ${likePattern(query.search)} ESCAPE '\\'`
      : sql`1 = 1`;

    return newestFirstPage(this.session, sql`groups`, where, query, groupFromRow);
  }

  async update(
    id: GroupId,
    update: { spec: GroupSpec; updatedAt: Date },
    expectedVersion: number,
  ): Promise<Result<Group, VersionConflictError | NotFoundError | ConflictError>> {
    const current = await this.get(id);
    if (!current) {
      return err({ code: 'not_found', message: `Group ${id} not found` });
    }
    const next: Group = Group.parse({
      ...current,
      ...update.spec,
      updatedAt: update.updatedAt,
      version: expectedVersion + 1,
    });
    const clash = await this.findByName(next.name);
    if (clash && clash.id !== id) {
      return err(nameTaken(next.name));
    }
    try {
      const changed = await this.session.run(sql`
        UPDATE groups SET name = ${next.name}, version = ${next.version},
          doc = ${this.session.dialect.json(encodeDoc(next))}
        WHERE id = ${id} AND version = ${expectedVersion}`);

      return changed === 1
        ? ok(next)
        : err({ code: 'version_conflict', message: `Group ${id} was modified concurrently` });
    } catch (error: unknown) {
      if (this.session.dialect.isUniqueViolation(error)) {
        return err(nameTaken(next.name));
      }
      throw error;
    }
  }

  async delete(id: GroupId): Promise<boolean> {
    return (await this.session.run(sql`DELETE FROM groups WHERE id = ${id}`)) === 1;
  }
}

const LimitRow = z.object({
  tokens: z.union([z.number(), z.string()]).transform(Number).nullable(),
  refilled_at: DateColumn.nullable(),
  running: Epoch,
  touched_at: DateColumn.nullable(),
});

export class SqlRateLimiter implements RateLimiter {
  constructor(
    private readonly session: SqlSession,
    private readonly concurrencyRetryMs = 250,
  ) {}

  tryAcquire(key: string, limit: RateLimit, now: Date): Promise<AcquireResult> {
    return this.session.transaction(async () => {
      await this.session.run(
        sql`INSERT INTO rate_limits (key, running) VALUES (${key}, 0) ON CONFLICT DO NOTHING`,
      );
      const [row] = await this.session.all(
        sql`SELECT * FROM rate_limits WHERE key = ${key} ${this.session.dialect.forUpdate}`,
      );
      const state = LimitRow.parse(row);
      const rate = limit.perSecond;
      const capacity = rate === undefined ? undefined : Math.max(1, rate);
      const elapsedSeconds = (now.getTime() - (state.refilled_at ?? now).getTime()) / 1_000;
      const tokens =
        capacity === undefined || rate === undefined
          ? null
          : Math.min(capacity, (state.tokens ?? capacity) + elapsedSeconds * rate);
      const max = limit.maxConcurrent;
      const granted =
        (max === undefined || state.running < max) && (tokens === null || tokens >= 1);
      const running = max !== undefined && granted ? state.running + 1 : state.running;
      await this.session.run(sql`
        UPDATE rate_limits SET running = ${running},
          tokens = ${tokens === null ? null : granted ? tokens - 1 : tokens},
          refilled_at = ${now.getTime()},
          touched_at = ${granted ? now.getTime() : (state.touched_at?.getTime() ?? null)}
        WHERE key = ${key}`);
      if (granted) {
        return { ok: true, holdsSlot: max !== undefined };
      }
      const waits = [
        max !== undefined && state.running >= max ? this.concurrencyRetryMs : 0,
        rate !== undefined && (tokens ?? 0) < 1
          ? Math.ceil(((1 - (tokens ?? 0)) / rate) * 1_000)
          : 0,
      ];

      return { ok: false, retryAt: new Date(now.getTime() + Math.max(1, ...waits)) };
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
