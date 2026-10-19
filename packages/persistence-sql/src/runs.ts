import {
  type DomainError,
  FAILURE_LIKE_STATUSES,
  type JobId,
  type PendingRun,
  type Result,
  Run,
  type RunId,
  type RunQuery,
  type RunQueue,
  type RunRepository,
  type RunStatus,
  type RunningRun,
  type SlaUpdate,
  type StaleRunError,
  bufferFull,
  duplicateRun,
  err,
  ok,
  overlapSlotKey,
  pruneGroups,
  staleRun,
} from '@cloud-trigger/core';
import { type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { Count, Flag, decodeDoc, encodeDoc, epochOrNull, flag } from './codec.js';
import type { ChangeSink } from './events.js';
import { ALL_ROWS, and, inList, newestFirstPage, sameAs } from './query.js';
import { type RowValues, assignments, insertInto, rowParser } from './rows.js';
import type { Row, SqlSession } from './session.js';

const parseRunRow = rowParser('runs');

export const runFromRow = (row: Row): Run => {
  const parsed = parseRunRow(row);
  const doc = z.record(z.string(), z.unknown()).parse(decodeDoc(parsed.doc));

  return Run.parse({
    ...doc,
    status: parsed.status,
    updatedAt: parsed.updated_at,
    late: parsed.late,
    lateReasons: z.array(z.string()).parse(decodeDoc(parsed.late_reasons)),
    slaDeadline: parsed.sla_deadline,
    acknowledgedAt: parsed.acknowledged_at,
    rateLimitKey: parsed.rate_limit_key,
    ...(parsed.status === 'pending' && { availableAt: parsed.available_at }),
    ...(parsed.status === 'running' && {
      startedAt: parsed.started_at,
      lease: { workerId: parsed.lease_worker, until: parsed.lease_until },
      cancelRequested: parsed.cancel_requested,
    }),
  });
};

const runningFromRow = (row: Row): RunningRun => {
  const run = runFromRow(row);
  if (run.status !== 'running') {
    throw new Error(`Run ${run.id} is ${run.status}, expected running`);
  }

  return run;
};

const runColumns = (run: Run, overlapSlot: string | null): RowValues<'runs'> => ({
  id: run.id,
  job_id: run.jobId,
  status: run.status,
  reason: run.reason,
  scheduled_at: run.scheduledAt,
  available_at: run.status === 'pending' ? run.availableAt : null,
  started_at: run.status === 'running' ? run.startedAt : null,
  lease_worker: run.status === 'running' ? run.lease.workerId : null,
  lease_until: run.status === 'running' ? run.lease.until : null,
  cancel_requested: run.status === 'running' && run.cancelRequested,
  idempotency_key: run.idempotencyKey,
  overlap_slot: overlapSlot,
  finished_at: run.status === 'pending' || run.status === 'running' ? null : run.finishedAt,
  late: run.late,
  late_reasons: encodeDoc(run.lateReasons),
  sla_deadline: run.slaDeadline,
  sla_max_duration_ms: run.slaMaxDurationMs,
  acknowledged_at: run.acknowledgedAt,
  rate_limit_key: run.rateLimitKey,
  created_at: run.createdAt,
  updated_at: run.updatedAt,
  doc: run,
});

export async function insertRun(
  session: SqlSession,
  run: PendingRun,
  overlapSlot: string | null = null,
): Promise<boolean> {
  const inserted = await session.run(
    sql`${insertInto(session, 'runs', runColumns(run, overlapSlot))} ON CONFLICT DO NOTHING`,
  );

  return inserted === 1;
}

const casWhere = (previous: Run): SQL =>
  previous.status === 'running'
    ? sql`id = ${previous.id} AND status = 'running' AND updated_at = ${previous.updatedAt.getTime()}
        AND lease_worker = ${previous.lease.workerId} AND lease_until = ${previous.lease.until.getTime()}`
    : sql`id = ${previous.id} AND status = ${previous.status} AND updated_at = ${previous.updatedAt.getTime()}`;

const replacement = (session: SqlSession, next: Run, keepLateness: boolean): SQL => {
  const {
    id: _id,
    job_id: _jobId,
    idempotency_key: _key,
    overlap_slot: _slot,
    created_at: _createdAt,
    late,
    late_reasons: lateReasons,
    sla_deadline: slaDeadline,
    ...changed
  } = runColumns(next, null);
  const lateness = keepLateness
    ? sql`late = CASE WHEN late = 1 THEN 1 ELSE CAST(${flag(late)} AS INTEGER) END,
        late_reasons = CASE WHEN late = 1 THEN late_reasons ELSE ${lateReasons} END,
        sla_deadline = CASE WHEN late = 1 THEN NULL ELSE CAST(${epochOrNull(slaDeadline)} AS BIGINT) END`
    : assignments(session, 'runs', { late, late_reasons: lateReasons, sla_deadline: slaDeadline });

  return sql`${assignments(session, 'runs', changed)}, ${lateness}`;
};

export class SqlRunRepository implements RunRepository {
  constructor(
    private readonly session: SqlSession,
    private readonly changes?: ChangeSink | undefined,
  ) {}

  async insert(
    run: PendingRun,
    opts: { durableKey?: boolean } = {},
  ): Promise<Result<PendingRun, DomainError<'duplicate_run'>>> {
    const durableKey = opts.durableKey === true ? run.idempotencyKey : null;
    if (durableKey !== null) {
      const [held] = await this.session.all(
        sql`SELECT count(*) AS count FROM fire_keys WHERE key = ${durableKey}`,
      );
      if (Count.parse(held).count > 0) {
        return err(duplicateRun(run));
      }
    }
    if (!(await insertRun(this.session, run))) {
      return err(duplicateRun(run));
    }
    if (durableKey !== null) {
      await this.session.run(
        sql`${insertInto(this.session, 'fire_keys', {
          key: durableKey,
          job_id: run.jobId,
          created_at: run.createdAt,
        })} ON CONFLICT DO NOTHING`,
      );
    }
    this.changes?.runChanged(run.id);

    return ok(run);
  }

  async get(id: RunId): Promise<Run | undefined> {
    const [row] = await this.session.all(sql`SELECT * FROM runs WHERE id = ${id}`);

    return row ? runFromRow(row) : undefined;
  }

  list(query: RunQuery) {
    const where = and([
      query.jobId ? sql`job_id = ${query.jobId}` : undefined,
      query.status?.length ? sql`status IN (${inList(query.status)})` : undefined,
      query.reason ? sql`reason = ${query.reason}` : undefined,
      query.late === undefined ? undefined : sql`late = ${flag(query.late)}`,
      query.acknowledged === undefined
        ? undefined
        : query.acknowledged
          ? sql`acknowledged_at IS NOT NULL`
          : sql`acknowledged_at IS NULL`,
      query.from ? sql`scheduled_at >= ${query.from.getTime()}` : undefined,
      query.to ? sql`scheduled_at < ${query.to.getTime()}` : undefined,
    ]);

    return newestFirstPage(this.session, sql`runs`, where, query, runFromRow);
  }

  async transition(previous: Run, next: Run): Promise<Result<Run, StaleRunError>> {
    const [row] = await this.session.all(sql`
      UPDATE runs SET ${replacement(this.session, next, true)}, overlap_slot = NULL
      WHERE ${casWhere(previous)} RETURNING *`);
    if (!row) {
      return err(staleRun(previous.id));
    }
    this.changes?.runChanged(previous.id);

    return ok(runFromRow(row));
  }

  async countByStatus(jobId: JobId, statuses: readonly RunStatus[]): Promise<number> {
    const [row] = await this.session.all(
      sql`SELECT count(*) AS count FROM runs WHERE job_id = ${jobId} AND status IN (${inList(statuses)})`,
    );

    return Count.parse(row).count;
  }

  async findByStatus(jobId: JobId, statuses: readonly RunStatus[]): Promise<readonly Run[]> {
    const rows = await this.session.all(
      sql`SELECT * FROM runs WHERE job_id = ${jobId} AND status IN (${inList(statuses)}) ORDER BY id`,
    );

    return rows.map(runFromRow);
  }

  async countHoldingSlot(key: string): Promise<number> {
    const [row] = await this.session.all(
      sql`SELECT count(*) AS count FROM runs WHERE status = 'running' AND rate_limit_key = ${key}`,
    );

    return Count.parse(row).count;
  }

  async markSlotHeld(run: RunningRun, key: string): Promise<boolean> {
    const changed = await this.session.run(sql`
      UPDATE runs SET rate_limit_key = ${key}
      WHERE id = ${run.id} AND status = 'running' AND lease_worker = ${run.lease.workerId}`);

    return changed === 1;
  }

  async acknowledge(ids: readonly RunId[], at: Date): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }

    return this.session.run(sql`
      UPDATE runs SET acknowledged_at = ${at.getTime()}
      WHERE id IN (${inList(ids)}) AND status IN (${inList(FAILURE_LIKE_STATUSES)})
        AND acknowledged_at IS NULL`);
  }

  async findLateCandidates(p: { now: Date; limit: number }) {
    const rows = await this.session.all(sql`
      SELECT * FROM runs WHERE status IN ('pending', 'running') AND late = 0
        AND sla_deadline <= ${p.now.getTime()}
      ORDER BY sla_deadline LIMIT ${p.limit}`);

    return rows
      .map(runFromRow)
      .filter((run) => run.status === 'pending' || run.status === 'running');
  }

  async updateSla(run: PendingRun | RunningRun, update: SlaUpdate): Promise<boolean> {
    const changed = await this.session.run(sql`
      UPDATE runs SET late = ${flag(update.late)}, late_reasons = ${encodeDoc(update.lateReasons)},
        sla_deadline = ${epochOrNull(update.slaDeadline)}
      WHERE id = ${run.id} AND status = ${run.status} AND late = 0
        AND sla_deadline ${sameAs(this.session.dialect)} ${epochOrNull(run.slaDeadline)}`);

    return changed === 1;
  }

  async prune(jobId: JobId, keep: { succeeded: number; failed: number }): Promise<number> {
    let deleted = 0;
    for (const [statuses, count] of pruneGroups(keep)) {
      const stalest = await this.session.all(sql`
        SELECT id FROM runs WHERE job_id = ${jobId} AND status IN (${inList(statuses)})
        ORDER BY id DESC LIMIT ${ALL_ROWS} OFFSET ${count}`);
      const ids = stalest.map((row) => z.string().parse(row['id']));
      if (ids.length > 0) {
        deleted += await this.session.run(sql`DELETE FROM runs WHERE id IN (${inList(ids)})`);
      }
    }

    return deleted;
  }
}

export class SqlRunQueue implements RunQueue {
  constructor(
    private readonly session: SqlSession,
    private readonly changes?: ChangeSink | undefined,
  ) {}

  async claimNext(p: {
    workerId: string;
    now: Date;
    leaseMs: number;
  }): Promise<RunningRun | undefined> {
    const now = p.now.getTime();
    const [row] = await this.session.all(sql`
      UPDATE runs SET status = 'running', started_at = ${now}, lease_worker = ${p.workerId},
        lease_until = ${now + p.leaseMs}, cancel_requested = 0, rate_limit_key = NULL,
        updated_at = ${now}, available_at = NULL, overlap_slot = NULL,
        sla_deadline = CASE
          WHEN late = 1 THEN NULL
          WHEN sla_deadline IS NOT NULL AND sla_deadline <= ${now} THEN sla_deadline
          WHEN sla_max_duration_ms IS NOT NULL THEN ${now} + sla_max_duration_ms
          ELSE NULL END
      WHERE id = (
        SELECT id FROM runs WHERE status = 'pending' AND available_at <= ${now}
        ORDER BY available_at, id LIMIT 1 ${this.session.dialect.skipLocked})
      RETURNING *`);
    if (!row) {
      return undefined;
    }
    const claimed = runningFromRow(row);
    this.changes?.runChanged(claimed.id);

    return claimed;
  }

  async renewLease(p: { runId: RunId; workerId: string; until: Date }) {
    const [row] = await this.session.all(sql`
      UPDATE runs SET lease_until = ${p.until.getTime()}
      WHERE id = ${p.runId} AND status = 'running' AND lease_worker = ${p.workerId}
      RETURNING cancel_requested`);

    return {
      renewed: row !== undefined,
      cancelRequested: row !== undefined && Flag.parse(row['cancel_requested']),
    };
  }

  async requestCancel(runId: RunId): Promise<boolean> {
    const changed = await this.session.run(
      sql`UPDATE runs SET cancel_requested = 1 WHERE id = ${runId} AND status = 'running'`,
    );

    return changed === 1;
  }

  async findExpired(p: { now: Date; limit: number }): Promise<readonly RunningRun[]> {
    const rows = await this.session.all(sql`
      SELECT * FROM runs WHERE status = 'running' AND lease_until < ${p.now.getTime()}
      LIMIT ${p.limit}`);

    return rows.map(runningFromRow);
  }

  async acquireExecution(run: RunningRun): Promise<boolean> {
    const slot = overlapSlotKey(run.jobId, 'exec');
    try {
      const changed = await this.session.run(sql`
        UPDATE runs SET overlap_slot = ${slot}
        WHERE id = ${run.id} AND status = 'running' AND lease_worker = ${run.lease.workerId}
          AND NOT EXISTS (SELECT 1 FROM runs held WHERE held.overlap_slot = ${slot} AND held.id <> ${run.id})`);

      return changed === 1;
    } catch (error: unknown) {
      if (this.session.dialect.isUniqueViolation(error)) {
        return false;
      }
      throw error;
    }
  }

  async buffer(
    previous: RunningRun,
    next: PendingRun,
  ): Promise<Result<PendingRun, StaleRunError | DomainError<'buffer_full'>>> {
    const slot = overlapSlotKey(next.jobId, 'buffer');
    try {
      const [taken] = await this.session.all(
        sql`SELECT id FROM runs WHERE overlap_slot = ${slot} AND id <> ${previous.id}`,
      );
      if (taken) {
        return err(bufferFull(next.jobId));
      }
      const changed = await this.session.run(sql`
        UPDATE runs SET ${replacement(this.session, next, false)}, overlap_slot = ${slot}
        WHERE ${casWhere(previous)}`);
      if (changed === 0) {
        return err(staleRun(previous.id));
      }
      this.changes?.runChanged(next.id);

      return ok(next);
    } catch (error: unknown) {
      if (this.session.dialect.isUniqueViolation(error)) {
        return err(bufferFull(next.jobId));
      }
      throw error;
    }
  }
}

export const loadRunChanged = async (
  session: SqlSession,
  id: string,
): Promise<{ type: 'run.changed'; run: Run } | undefined> => {
  const [row] = await session.all(sql`SELECT * FROM runs WHERE id = ${id}`);

  return row ? { type: 'run.changed', run: runFromRow(row) } : undefined;
};
