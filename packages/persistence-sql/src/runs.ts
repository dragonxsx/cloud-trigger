import {
  type DomainError,
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
  err,
  ok,
} from '@cloud-trigger/core';
import { type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { Count, DateColumn, Flag, decodeDoc, encodeDoc, epochOrNull, flag } from './codec.js';
import type { ChangeSink } from './events.js';
import { ALL_ROWS, and, inList, newestFirstPage, sameAs } from './query.js';
import type { Row, SqlSession } from './session.js';

const SUCCESS_LIKE: readonly RunStatus[] = ['succeeded', 'cancelled', 'skipped'];
const FAILURE_LIKE: readonly RunStatus[] = ['failed', 'timed_out'];

const RunRow = z.looseObject({
  doc: z.unknown(),
  status: z.string(),
  available_at: DateColumn.nullable(),
  started_at: DateColumn.nullable(),
  lease_worker: z.string().nullable(),
  lease_until: DateColumn.nullable(),
  cancel_requested: Flag,
  late: Flag,
  late_reasons: z.string(),
  sla_deadline: DateColumn.nullable(),
  acknowledged_at: DateColumn.nullable(),
  rate_limit_key: z.string().nullable(),
  updated_at: DateColumn,
});

export const runFromRow = (row: Row): Run => {
  const parsed = RunRow.parse(row);
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

interface RunColumns {
  readonly id: string;
  readonly job_id: string;
  readonly status: string;
  readonly reason: string;
  readonly scheduled_at: number;
  readonly available_at: number | null;
  readonly started_at: number | null;
  readonly lease_worker: string | null;
  readonly lease_until: number | null;
  readonly cancel_requested: number;
  readonly idempotency_key: string | null;
  readonly finished_at: number | null;
  readonly late: number;
  readonly late_reasons: string;
  readonly sla_deadline: number | null;
  readonly sla_max_duration_ms: number | null;
  readonly acknowledged_at: number | null;
  readonly rate_limit_key: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

const columnsOf = (run: Run): RunColumns => ({
  id: run.id,
  job_id: run.jobId,
  status: run.status,
  reason: run.reason,
  scheduled_at: run.scheduledAt.getTime(),
  available_at: run.status === 'pending' ? run.availableAt.getTime() : null,
  started_at: run.status === 'running' ? run.startedAt.getTime() : null,
  lease_worker: run.status === 'running' ? run.lease.workerId : null,
  lease_until: run.status === 'running' ? run.lease.until.getTime() : null,
  cancel_requested: flag(run.status === 'running' && run.cancelRequested),
  idempotency_key: run.idempotencyKey,
  finished_at:
    run.status === 'pending' || run.status === 'running' ? null : run.finishedAt.getTime(),
  late: flag(run.late),
  late_reasons: encodeDoc(run.lateReasons),
  sla_deadline: epochOrNull(run.slaDeadline),
  sla_max_duration_ms: run.slaMaxDurationMs,
  acknowledged_at: epochOrNull(run.acknowledgedAt),
  rate_limit_key: run.rateLimitKey,
  created_at: run.createdAt.getTime(),
  updated_at: run.updatedAt.getTime(),
});

export async function insertRun(
  session: SqlSession,
  run: PendingRun,
  overlapSlot: string | null = null,
): Promise<boolean> {
  const c = columnsOf(run);
  const inserted = await session.run(sql`
    INSERT INTO runs (id, job_id, status, reason, scheduled_at, available_at, started_at,
      lease_worker, lease_until, cancel_requested, idempotency_key, overlap_slot, finished_at,
      late, late_reasons, sla_deadline, sla_max_duration_ms, acknowledged_at, rate_limit_key,
      created_at, updated_at, doc)
    VALUES (${c.id}, ${c.job_id}, ${c.status}, ${c.reason}, ${c.scheduled_at}, ${c.available_at},
      ${c.started_at}, ${c.lease_worker}, ${c.lease_until}, ${c.cancel_requested},
      ${c.idempotency_key}, ${overlapSlot}, ${c.finished_at}, ${c.late}, ${c.late_reasons},
      ${c.sla_deadline}, ${c.sla_max_duration_ms}, ${c.acknowledged_at}, ${c.rate_limit_key},
      ${c.created_at}, ${c.updated_at}, ${session.dialect.json(encodeDoc(run))})
    ON CONFLICT DO NOTHING`);

  return inserted === 1;
}

const casWhere = (previous: Run): SQL =>
  previous.status === 'running'
    ? sql`id = ${previous.id} AND status = 'running' AND updated_at = ${previous.updatedAt.getTime()}
        AND lease_worker = ${previous.lease.workerId} AND lease_until = ${previous.lease.until.getTime()}`
    : sql`id = ${previous.id} AND status = ${previous.status} AND updated_at = ${previous.updatedAt.getTime()}`;

const fullSet = (session: SqlSession, next: Run, keepLateness: boolean): SQL => {
  const c = columnsOf(next);

  return sql`status = ${c.status}, reason = ${c.reason}, scheduled_at = ${c.scheduled_at},
    available_at = ${c.available_at}, started_at = ${c.started_at},
    lease_worker = ${c.lease_worker}, lease_until = ${c.lease_until},
    cancel_requested = ${c.cancel_requested}, finished_at = ${c.finished_at},
    ${
      keepLateness
        ? sql`late = CASE WHEN late = 1 THEN 1 ELSE CAST(${c.late} AS INTEGER) END,
            late_reasons = CASE WHEN late = 1 THEN late_reasons ELSE ${c.late_reasons} END,
            sla_deadline = CASE WHEN late = 1 THEN NULL ELSE CAST(${c.sla_deadline} AS BIGINT) END`
        : sql`late = ${c.late}, late_reasons = ${c.late_reasons}, sla_deadline = ${c.sla_deadline}`
    },
    sla_max_duration_ms = ${c.sla_max_duration_ms}, acknowledged_at = ${c.acknowledged_at},
    rate_limit_key = ${c.rate_limit_key}, updated_at = ${c.updated_at},
    doc = ${session.dialect.json(encodeDoc(next))}`;
};

const duplicateRun = (run: PendingRun): DomainError<'duplicate_run'> => ({
  code: 'duplicate_run',
  message: `Run with key ${run.idempotencyKey ?? run.id} exists`,
});

const stale = (id: string): StaleRunError => ({
  code: 'stale_run',
  message: `Run ${id} changed since it was read`,
});

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
      await this.session.run(sql`
        INSERT INTO fire_keys (key, job_id, created_at)
        VALUES (${durableKey}, ${run.jobId}, ${run.createdAt.getTime()}) ON CONFLICT DO NOTHING`);
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
      UPDATE runs SET ${fullSet(this.session, next, true)}, overlap_slot = NULL
      WHERE ${casWhere(previous)} RETURNING *`);
    if (!row) {
      return err(stale(previous.id));
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
      WHERE id IN (${inList(ids)}) AND status IN (${inList(FAILURE_LIKE)})
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
    for (const [statuses, count] of [
      [SUCCESS_LIKE, keep.succeeded],
      [FAILURE_LIKE, keep.failed],
    ] as const) {
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
    const slot = `${run.jobId}:exec`;
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
    const slot = `${next.jobId}:buffer`;
    const bufferFull: DomainError<'buffer_full'> = {
      code: 'buffer_full',
      message: `Job ${next.jobId} already has a buffered run`,
    };
    try {
      const [taken] = await this.session.all(
        sql`SELECT id FROM runs WHERE overlap_slot = ${slot} AND id <> ${previous.id}`,
      );
      if (taken) {
        return err(bufferFull);
      }
      const changed = await this.session.run(sql`
        UPDATE runs SET ${fullSet(this.session, next, false)}, overlap_slot = ${slot}
        WHERE ${casWhere(previous)}`);
      if (changed === 0) {
        return err(stale(previous.id));
      }
      this.changes?.runChanged(next.id);

      return ok(next);
    } catch (error: unknown) {
      if (this.session.dialect.isUniqueViolation(error)) {
        return err(bufferFull);
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
