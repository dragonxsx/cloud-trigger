import {
  AUTO_PAUSE_REASON,
  Job,
  type JobId,
  type JobQuery,
  type JobRepository,
  type JobUpdate,
  type NotFoundError,
  type PendingRun,
  type Result,
  type ScheduleState,
  type ScheduleStore,
  type StaleClaimError,
  type VersionConflictError,
  err,
  notFound,
  ok,
  staleClaim,
  userEditableJobFields,
  versionConflict,
} from '@cloud-trigger/core';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { decodeDoc, epochOrNull, flag } from './codec.js';
import type { ChangeSink } from './events.js';
import { and, containsInsensitive, newestFirstPage, sameAs } from './query.js';
import { type RowChanges, type RowValues, assignments, insertInto, rowParser } from './rows.js';
import { insertRun } from './runs.js';
import type { Row, SqlSession } from './session.js';

const parseJobRow = rowParser('jobs');

export const jobFromRow = (row: Row): Job => {
  const parsed = parseJobRow(row);
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

const jobColumns = (job: Job): RowValues<'jobs'> => ({
  id: job.id,
  name: job.name,
  enabled: job.enabled,
  paused_reason: job.pausedReason,
  group_id: job.groupId,
  event_source: job.eventSource,
  workflow_id: job.workflowId,
  next_fire_at: job.schedule.nextFireAt,
  last_fired_at: job.schedule.lastFiredAt,
  last_success_at: job.schedule.lastSuccessAt,
  fire_count: job.schedule.fireCount,
  consecutive_failures: job.schedule.consecutiveFailures,
  success_deadline: job.schedule.successDeadline,
  sla_breached_at: job.slaBreachedAt,
  scheduler_owner: null,
  scheduler_until: null,
  version: job.version,
  created_at: job.createdAt,
  updated_at: job.updatedAt,
  doc: job,
});

const scheduleColumns = (schedule: Partial<ScheduleState>): RowChanges<'jobs'> => ({
  next_fire_at: schedule.nextFireAt,
  last_fired_at: schedule.lastFiredAt,
  last_success_at: schedule.lastSuccessAt,
  fire_count: schedule.fireCount,
  consecutive_failures: schedule.consecutiveFailures,
  success_deadline: schedule.successDeadline,
});

const hasChanges = (changes: object): boolean =>
  Object.values(changes).some((value) => value !== undefined);

export class SqlJobRepository implements JobRepository {
  constructor(
    private readonly session: SqlSession,
    private readonly changes?: ChangeSink | undefined,
  ) {}

  #set(job: Job, columns: readonly (keyof RowValues<'jobs'>)[]) {
    const values = jobColumns(job);

    return assignments(
      this.session,
      'jobs',
      Object.fromEntries(columns.map((column) => [column, values[column]])),
    );
  }

  async #writeEdges(
    job: Pick<Job, 'id' | 'tags' | 'upstreamJobIds' | 'connectionRefs'>,
  ): Promise<void> {
    await this.#deleteEdges(job.id);
    for (const tag of new Set(job.tags)) {
      await this.session.run(insertInto(this.session, 'job_tags', { job_id: job.id, tag }));
    }
    for (const upstream of new Set(job.upstreamJobIds)) {
      await this.session.run(
        insertInto(this.session, 'job_upstreams', { job_id: job.id, upstream_id: upstream }),
      );
    }
    const edges = new Map(
      job.connectionRefs.map((ref) => {
        const endpoint = ref.endpoint ?? '';

        return [`${ref.key}/${endpoint}`, { key: ref.key, endpoint }];
      }),
    );
    for (const edge of edges.values()) {
      await this.session.run(
        insertInto(this.session, 'job_connections', {
          job_id: job.id,
          connection_key: edge.key,
          endpoint_key: edge.endpoint,
        }),
      );
    }
  }

  async #deleteEdges(id: JobId): Promise<void> {
    await this.session.run(sql`DELETE FROM job_tags WHERE job_id = ${id}`);
    await this.session.run(sql`DELETE FROM job_upstreams WHERE job_id = ${id}`);
    await this.session.run(sql`DELETE FROM job_connections WHERE job_id = ${id}`);
  }

  async insert(job: Job): Promise<void> {
    await this.session.transaction(async () => {
      await this.session.run(insertInto(this.session, 'jobs', jobColumns(job)));
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
      containsInsensitive(this.session.dialect, 'name', query.search),
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
          return err(notFound('Job', id));
        }
        const current = jobFromRow(row);
        const { reschedule } = update;
        const stale =
          current.version !== expectedVersion ||
          (reschedule !== undefined &&
            (current.schedule.nextFireAt?.getTime() !== reschedule.basedOn.nextFireAt?.getTime() ||
              current.schedule.fireCount !== reschedule.basedOn.fireCount));
        if (stale) {
          return err(versionConflict('Job', id));
        }
        const next: Job = Job.parse({
          ...current,
          ...userEditableJobFields(update.spec),
          upstreamJobIds: update.upstreamJobIds
            ? [...update.upstreamJobIds]
            : current.upstreamJobIds,
          connectionRefs: update.connectionRefs
            ? [...update.connectionRefs]
            : current.connectionRefs,
          eventSource: update.eventSource === undefined ? current.eventSource : update.eventSource,
          version: expectedVersion + 1,
          updatedAt: update.updatedAt,
          schedule: {
            ...current.schedule,
            ...(reschedule && { nextFireAt: reschedule.nextFireAt }),
          },
        });
        await this.session.run(sql`
          UPDATE jobs SET ${this.#set(next, [
            'name',
            'enabled',
            'group_id',
            'event_source',
            'next_fire_at',
            'scheduler_owner',
            'scheduler_until',
            'version',
            'updated_at',
            'doc',
          ])}
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
      await this.#deleteEdges(id);

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
    const changes: RowChanges<'jobs'> = {
      ...scheduleColumns(patch),
      paused_reason: extra.pausedReason,
      sla_breached_at: extra.slaBreachedAt,
    };
    if (hasChanges(changes)) {
      await this.session.run(
        sql`UPDATE jobs SET ${assignments(this.session, 'jobs', changes)} WHERE id = ${id}`,
      );
    }
  }

  async recordFailure(id: JobId, p: { pauseAfter?: number | undefined }): Promise<void> {
    const pause =
      p.pauseAfter === undefined
        ? sql`paused_reason`
        : sql`CASE WHEN paused_reason IS NULL AND consecutive_failures + 1 >= ${p.pauseAfter}
            THEN ${AUTO_PAUSE_REASON.prefix} || CAST(consecutive_failures + 1 AS TEXT) || ${AUTO_PAUSE_REASON.suffix}
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

  async findByConnection(key: string, endpoint?: string): Promise<readonly Job[]> {
    const rows = await this.session.all(sql`
      SELECT * FROM jobs WHERE EXISTS (
        SELECT 1 FROM job_connections c
        WHERE c.job_id = jobs.id AND c.connection_key = ${key}
        ${endpoint === undefined ? sql`` : sql`AND c.endpoint_key = ${endpoint}`}
      ) ORDER BY id`);

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
      UPDATE jobs SET ${assignments(this.session, 'jobs', {
        sla_breached_at: update.slaBreachedAt,
        success_deadline: update.successDeadline,
      })}
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
          UPDATE jobs SET ${assignments(this.session, 'jobs', {
            ...scheduleColumns(p.schedule),
            scheduler_owner: null,
            scheduler_until: null,
          })}
          WHERE id = ${p.jobId} AND version = ${p.jobVersion} AND scheduler_owner = ${p.ownerId}
            AND scheduler_until > ${p.now.getTime()}`);
        if (claimed === 0) {
          return err(staleClaim(p.jobId));
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
