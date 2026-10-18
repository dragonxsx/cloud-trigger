import {
  Job,
  type JobId,
  type JobQuery,
  type JobRepository,
  JobSpec,
  type JobUpdate,
  type NotFoundError,
  type PendingRun,
  type Result,
  type ScheduleState,
  type ScheduleStore,
  type StaleClaimError,
  type VersionConflictError,
  err,
  ok,
} from '@cloud-trigger/core';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { DateColumn, Epoch, decodeDoc, encodeDoc, epochOrNull, flag } from './codec.js';
import type { ChangeSink } from './events.js';
import { and, likePattern, newestFirstPage, sameAs } from './query.js';
import { insertRun } from './runs.js';
import type { Row, SqlSession } from './session.js';

const JobRow = z.looseObject({
  doc: z.unknown(),
  enabled: z.unknown(),
  paused_reason: z.string().nullable(),
  next_fire_at: DateColumn.nullable(),
  last_fired_at: DateColumn.nullable(),
  last_success_at: DateColumn.nullable(),
  fire_count: Epoch,
  consecutive_failures: Epoch,
  success_deadline: DateColumn.nullable(),
  sla_breached_at: DateColumn.nullable(),
  event_source: z.string().nullable(),
  version: Epoch,
  updated_at: DateColumn,
});

export const jobFromRow = (row: Row): Job => {
  const parsed = JobRow.parse(row);
  const doc = z.record(z.string(), z.unknown()).parse(decodeDoc(parsed.doc));

  return Job.parse({
    ...doc,
    pausedReason: parsed.paused_reason,
    slaBreachedAt: parsed.sla_breached_at,
    eventSource: parsed.event_source,
    version: parsed.version,
    updatedAt: parsed.updated_at,
    schedule: {
      nextFireAt: parsed.next_fire_at,
      lastFiredAt: parsed.last_fired_at,
      lastSuccessAt: parsed.last_success_at,
      fireCount: parsed.fire_count,
      consecutiveFailures: parsed.consecutive_failures,
      successDeadline: parsed.success_deadline,
    },
  });
};

const SCHEDULE_COLUMNS = new Map<string, string>(
  Object.entries({
    nextFireAt: 'next_fire_at',
    lastFiredAt: 'last_fired_at',
    lastSuccessAt: 'last_success_at',
    fireCount: 'fire_count',
    consecutiveFailures: 'consecutive_failures',
    successDeadline: 'success_deadline',
  } satisfies Record<keyof ScheduleState, string>),
);

const columnValue = (value: Date | number | null): number | null =>
  value instanceof Date ? value.getTime() : value;

const SPEC_FIELDS = new Set(Object.keys(JobSpec.shape));

export class SqlJobRepository implements JobRepository {
  constructor(
    private readonly session: SqlSession,
    private readonly changes?: ChangeSink | undefined,
  ) {}

  async #writeEdges(job: Pick<Job, 'id' | 'tags' | 'upstreamJobIds'>): Promise<void> {
    await this.session.run(sql`DELETE FROM job_tags WHERE job_id = ${job.id}`);
    await this.session.run(sql`DELETE FROM job_upstreams WHERE job_id = ${job.id}`);
    for (const tag of new Set(job.tags)) {
      await this.session.run(sql`INSERT INTO job_tags (job_id, tag) VALUES (${job.id}, ${tag})`);
    }
    for (const upstream of new Set(job.upstreamJobIds)) {
      await this.session.run(
        sql`INSERT INTO job_upstreams (job_id, upstream_id) VALUES (${job.id}, ${upstream})`,
      );
    }
  }

  async insert(job: Job): Promise<void> {
    const { dialect } = this.session;
    await this.session.transaction(async () => {
      await this.session.run(sql`
        INSERT INTO jobs (id, name, enabled, paused_reason, group_id, event_source, workflow_id,
          next_fire_at, last_fired_at, last_success_at, fire_count, consecutive_failures,
          success_deadline, sla_breached_at, scheduler_owner, scheduler_until, version,
          created_at, updated_at, doc)
        VALUES (${job.id}, ${job.name}, ${flag(job.enabled)}, ${job.pausedReason}, ${job.groupId},
          ${job.eventSource}, ${job.workflowId}, ${epochOrNull(job.schedule.nextFireAt)},
          ${epochOrNull(job.schedule.lastFiredAt)}, ${epochOrNull(job.schedule.lastSuccessAt)},
          ${job.schedule.fireCount}, ${job.schedule.consecutiveFailures},
          ${epochOrNull(job.schedule.successDeadline)}, ${epochOrNull(job.slaBreachedAt)},
          NULL, NULL, ${job.version}, ${job.createdAt.getTime()}, ${job.updatedAt.getTime()},
          ${dialect.json(encodeDoc(job))})`);
      await this.#writeEdges(job);
    });
    this.changes?.jobChanged('created', job.id);
  }

  async get(id: JobId): Promise<Job | undefined> {
    const [row] = await this.session.all(sql`SELECT * FROM jobs WHERE id = ${id}`);

    return row ? jobFromRow(row) : undefined;
  }

  list(query: JobQuery) {
    const where = and([
      query.search
        ? sql`name ${this.session.dialect.caseInsensitiveLike} ${likePattern(query.search)} ESCAPE '\\'`
        : undefined,
      query.tag
        ? sql`EXISTS (SELECT 1 FROM job_tags t WHERE t.job_id = jobs.id AND t.tag = ${query.tag})`
        : undefined,
      query.groupId ? sql`group_id = ${query.groupId}` : undefined,
      query.enabled === undefined ? undefined : sql`enabled = ${flag(query.enabled)}`,
      query.slaBreached === undefined
        ? undefined
        : query.slaBreached
          ? sql`sla_breached_at IS NOT NULL`
          : sql`sla_breached_at IS NULL`,
    ]);

    return newestFirstPage(this.session, sql`jobs`, where, query, jobFromRow);
  }

  async update(
    id: JobId,
    update: JobUpdate,
    expectedVersion: number,
  ): Promise<Result<Job, VersionConflictError | NotFoundError>> {
    const { dialect } = this.session;
    const result = await this.session.transaction(
      async (): Promise<Result<Job, VersionConflictError | NotFoundError>> => {
        const [row] = await this.session.all(
          sql`SELECT * FROM jobs WHERE id = ${id} ${dialect.forUpdate}`,
        );
        if (!row) {
          return err({ code: 'not_found', message: `Job ${id} not found` });
        }
        const current = jobFromRow(row);
        const { reschedule } = update;
        const stale =
          current.version !== expectedVersion ||
          (reschedule !== undefined &&
            (current.schedule.nextFireAt?.getTime() !== reschedule.basedOn.nextFireAt?.getTime() ||
              current.schedule.fireCount !== reschedule.basedOn.fireCount));
        if (stale) {
          return err({ code: 'version_conflict', message: `Job ${id} was modified concurrently` });
        }
        const spec = Object.fromEntries(
          Object.entries(update.spec).filter(([key]) => SPEC_FIELDS.has(key)),
        );
        const next: Job = Job.parse({
          ...current,
          ...spec,
          upstreamJobIds: update.upstreamJobIds
            ? [...update.upstreamJobIds]
            : current.upstreamJobIds,
          eventSource: update.eventSource === undefined ? current.eventSource : update.eventSource,
          version: expectedVersion + 1,
          updatedAt: update.updatedAt,
          schedule: {
            ...current.schedule,
            ...(reschedule && { nextFireAt: reschedule.nextFireAt }),
          },
        });
        await this.session.run(sql`
          UPDATE jobs SET name = ${next.name}, enabled = ${flag(next.enabled)},
            group_id = ${next.groupId}, event_source = ${next.eventSource},
            next_fire_at = ${epochOrNull(next.schedule.nextFireAt)},
            scheduler_owner = NULL, scheduler_until = NULL, version = ${next.version},
            updated_at = ${next.updatedAt.getTime()}, doc = ${dialect.json(encodeDoc(next))}
          WHERE id = ${id}`);
        await this.#writeEdges(next);

        return ok(next);
      },
    );
    if (result.isOk()) {
      this.changes?.jobChanged('updated', id);
    }

    return result;
  }

  async delete(id: JobId): Promise<boolean> {
    const deleted = await this.session.transaction(async () => {
      await this.session.run(sql`DELETE FROM job_tags WHERE job_id = ${id}`);
      await this.session.run(sql`DELETE FROM job_upstreams WHERE job_id = ${id}`);

      return this.session.run(sql`DELETE FROM jobs WHERE id = ${id}`);
    });
    if (deleted === 1) {
      this.changes?.jobChanged('deleted', id);
    }

    return deleted === 1;
  }

  async patchSchedule(
    id: JobId,
    patch: Partial<ScheduleState>,
    extra: { pausedReason?: string | null; slaBreachedAt?: Date | null } = {},
  ): Promise<void> {
    const sets = Object.entries(patch).flatMap(([key, value]) => {
      const column = SCHEDULE_COLUMNS.get(key);

      return column === undefined || value === undefined
        ? []
        : [sql`${sql.raw(column)} = ${columnValue(value)}`];
    });
    if (extra.pausedReason !== undefined) {
      sets.push(sql`paused_reason = ${extra.pausedReason}`);
    }
    if (extra.slaBreachedAt !== undefined) {
      sets.push(sql`sla_breached_at = ${epochOrNull(extra.slaBreachedAt)}`);
    }
    if (sets.length > 0) {
      await this.session.run(sql`UPDATE jobs SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`);
    }
  }

  async recordFailure(id: JobId, p: { pauseAfter?: number | undefined }): Promise<void> {
    const pause =
      p.pauseAfter === undefined
        ? sql`paused_reason`
        : sql`CASE WHEN paused_reason IS NULL AND consecutive_failures + 1 >= ${p.pauseAfter}
            THEN 'Auto-paused after ' || CAST(consecutive_failures + 1 AS TEXT) || ' consecutive failures'
            ELSE paused_reason END`;
    await this.session.run(sql`
      UPDATE jobs SET paused_reason = ${pause}, consecutive_failures = consecutive_failures + 1
      WHERE id = ${id}`);
  }

  async findDependants(jobId: JobId): Promise<readonly Job[]> {
    const rows = await this.session.all(sql`
      SELECT jobs.* FROM jobs JOIN job_upstreams u ON u.job_id = jobs.id
      WHERE u.upstream_id = ${jobId} ORDER BY jobs.id`);

    return rows.map(jobFromRow);
  }

  async findEventSourced(): Promise<readonly Job[]> {
    const rows = await this.session.all(
      sql`SELECT * FROM jobs WHERE event_source IS NOT NULL ORDER BY id`,
    );

    return rows.map(jobFromRow);
  }

  async findByName(name: string): Promise<readonly Job[]> {
    const rows = await this.session.all(sql`SELECT * FROM jobs WHERE name = ${name} ORDER BY id`);

    return rows.map(jobFromRow);
  }

  async findStaleJobs(p: { now: Date; limit: number }): Promise<readonly Job[]> {
    const rows = await this.session.all(sql`
      SELECT * FROM jobs WHERE enabled = 1 AND sla_breached_at IS NULL
        AND success_deadline <= ${p.now.getTime()}
      ORDER BY success_deadline LIMIT ${p.limit}`);

    return rows.map(jobFromRow);
  }

  async updateSlaState(
    job: Job,
    update: { slaBreachedAt: Date | null; successDeadline: Date | null },
  ): Promise<boolean> {
    const is = sameAs(this.session.dialect);
    const changed = await this.session.run(sql`
      UPDATE jobs SET sla_breached_at = ${epochOrNull(update.slaBreachedAt)},
        success_deadline = ${epochOrNull(update.successDeadline)}
      WHERE id = ${job.id} AND sla_breached_at ${is} ${epochOrNull(job.slaBreachedAt)}
        AND success_deadline ${is} ${epochOrNull(job.schedule.successDeadline)}`);

    return changed === 1;
  }
}

export class SqlScheduleStore implements ScheduleStore {
  constructor(
    private readonly session: SqlSession,
    private readonly changes?: ChangeSink | undefined,
  ) {}

  async claimDue(p: {
    now: Date;
    ownerId: string;
    leaseMs: number;
    limit: number;
  }): Promise<readonly Job[]> {
    const now = p.now.getTime();
    const rows = await this.session.all(sql`
      UPDATE jobs SET scheduler_owner = ${p.ownerId}, scheduler_until = ${now + p.leaseMs}
      WHERE id IN (
        SELECT id FROM jobs
        WHERE enabled = 1 AND paused_reason IS NULL AND next_fire_at <= ${now}
          AND (scheduler_until IS NULL OR scheduler_until < ${now})
        ORDER BY next_fire_at LIMIT ${p.limit} ${this.session.dialect.skipLocked})
      RETURNING *`);

    return rows
      .map(jobFromRow)
      .toSorted(
        (a, b) => (a.schedule.nextFireAt?.getTime() ?? 0) - (b.schedule.nextFireAt?.getTime() ?? 0),
      );
  }

  async commitFire(p: {
    jobId: JobId;
    jobVersion: number;
    ownerId: string;
    now: Date;
    runs: readonly PendingRun[];
    schedule: Pick<ScheduleState, 'nextFireAt' | 'lastFiredAt' | 'fireCount'>;
  }): Promise<Result<readonly PendingRun[], StaleClaimError>> {
    const result = await this.session.transaction(
      async (): Promise<Result<readonly PendingRun[], StaleClaimError>> => {
        const claimed = await this.session.run(sql`
          UPDATE jobs SET next_fire_at = ${epochOrNull(p.schedule.nextFireAt)},
            last_fired_at = ${epochOrNull(p.schedule.lastFiredAt)},
            fire_count = ${p.schedule.fireCount}, scheduler_owner = NULL, scheduler_until = NULL
          WHERE id = ${p.jobId} AND version = ${p.jobVersion} AND scheduler_owner = ${p.ownerId}
            AND scheduler_until > ${p.now.getTime()}`);
        if (claimed === 0) {
          return err({
            code: 'stale_claim',
            message: `Lost the scheduler claim on job ${p.jobId}`,
          });
        }
        const inserted: PendingRun[] = [];
        for (const run of p.runs) {
          if (await insertRun(this.session, run)) {
            inserted.push(run);
          }
        }

        return ok(inserted);
      },
    );
    if (result.isOk()) {
      for (const run of result.value) {
        this.changes?.runChanged(run.id);
      }
    }

    return result;
  }
}
