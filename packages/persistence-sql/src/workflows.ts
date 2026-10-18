import {
  type DuplicateWorkflowRunError,
  type NotFoundError,
  type Result,
  type StaleWorkflowRunError,
  type VersionConflictError,
  Workflow,
  type WorkflowChange,
  type WorkflowId,
  type WorkflowQuery,
  type WorkflowRepository,
  WorkflowRun,
  type WorkflowRunId,
  type WorkflowRunQuery,
  type WorkflowRunRepository,
  err,
  ok,
} from '@cloud-trigger/core';
import { sql } from 'drizzle-orm';

import { DocRow, decodeDoc, encodeDoc, epochOrNull, flag } from './codec.js';
import { and, inList, likePattern, newestFirstPage } from './query.js';
import type { Row, SqlSession } from './session.js';

const workflowFromRow = (row: Row): Workflow => Workflow.parse(decodeDoc(DocRow.parse(row).doc));
const runFromRow = (row: Row): WorkflowRun => WorkflowRun.parse(decodeDoc(DocRow.parse(row).doc));

const runColumns = (run: WorkflowRun) => {
  const states = Object.values(run.nodes);
  const deadlines = states.flatMap((state) =>
    state.status === 'waiting_approval' && state.deadline !== null
      ? [state.deadline.getTime()]
      : [],
  );

  return {
    hasQueued: flag(run.status === 'running' && states.some((state) => state.status === 'queued')),
    approvalDeadline:
      run.status === 'running' && deadlines.length > 0 ? Math.min(...deadlines) : null,
  };
};

export class SqlWorkflowRepository implements WorkflowRepository {
  constructor(private readonly session: SqlSession) {}

  async insert(workflow: Workflow): Promise<void> {
    await this.session.run(sql`
      INSERT INTO workflows (id, name, enabled, next_fire_at, version, created_at, doc)
      VALUES (${workflow.id}, ${workflow.name}, ${flag(workflow.enabled)},
        ${epochOrNull(workflow.nextFireAt)}, ${workflow.version}, ${workflow.createdAt.getTime()},
        ${this.session.dialect.json(encodeDoc(workflow))})`);
  }

  async get(id: WorkflowId): Promise<Workflow | undefined> {
    const [row] = await this.session.all(sql`SELECT doc FROM workflows WHERE id = ${id}`);

    return row ? workflowFromRow(row) : undefined;
  }

  list(query: WorkflowQuery) {
    const where = query.search
      ? sql`name ${this.session.dialect.caseInsensitiveLike} ${likePattern(query.search)} ESCAPE '\\'`
      : sql`1 = 1`;

    return newestFirstPage(this.session, sql`workflows`, where, query, workflowFromRow);
  }

  async update(
    id: WorkflowId,
    change: WorkflowChange,
    expectedVersion: number,
  ): Promise<Result<Workflow, VersionConflictError | NotFoundError>> {
    const current = await this.get(id);
    if (!current) {
      return err({ code: 'not_found', message: `Workflow ${id} not found` });
    }
    const next = Workflow.parse({
      ...current,
      ...change.spec,
      inlineJobIds: { ...change.inlineJobIds },
      nextFireAt: change.nextFireAt,
      updatedAt: change.updatedAt,
      version: expectedVersion + 1,
    });
    const changed = await this.session.run(sql`
      UPDATE workflows SET name = ${next.name}, enabled = ${flag(next.enabled)},
        next_fire_at = ${epochOrNull(next.nextFireAt)}, version = ${next.version},
        doc = ${this.session.dialect.json(encodeDoc(next))}
      WHERE id = ${id} AND version = ${expectedVersion}`);

    return changed === 1
      ? ok(next)
      : err({ code: 'version_conflict', message: `Workflow ${id} was modified concurrently` });
  }

  async delete(id: WorkflowId): Promise<boolean> {
    return (await this.session.run(sql`DELETE FROM workflows WHERE id = ${id}`)) === 1;
  }

  async findDue({ now, limit }: { now: Date; limit: number }): Promise<readonly Workflow[]> {
    const rows = await this.session.all(sql`
      SELECT doc FROM workflows WHERE enabled = 1 AND next_fire_at <= ${now.getTime()}
      ORDER BY next_fire_at LIMIT ${limit}`);

    return rows.map(workflowFromRow);
  }

  async advanceSchedule(
    id: WorkflowId,
    { from, to }: { from: Date; to: Date | null },
  ): Promise<boolean> {
    return this.session.transaction(async () => {
      const [row] = await this.session.all(
        sql`SELECT doc FROM workflows WHERE id = ${id} AND next_fire_at = ${from.getTime()} ${this.session.dialect.forUpdate}`,
      );
      if (!row) {
        return false;
      }
      const next = { ...workflowFromRow(row), nextFireAt: to };
      const changed = await this.session.run(sql`
        UPDATE workflows SET next_fire_at = ${epochOrNull(to)},
          doc = ${this.session.dialect.json(encodeDoc(next))}
        WHERE id = ${id} AND next_fire_at = ${from.getTime()}`);

      return changed === 1;
    });
  }
}

export class SqlWorkflowRunRepository implements WorkflowRunRepository {
  constructor(private readonly session: SqlSession) {}

  async insert(run: WorkflowRun): Promise<Result<WorkflowRun, DuplicateWorkflowRunError>> {
    const columns = runColumns(run);
    const inserted = await this.session.run(sql`
      INSERT INTO workflow_runs (id, workflow_id, status, idempotency_key, has_queued,
        approval_deadline, version, doc)
      VALUES (${run.id}, ${run.workflowId}, ${run.status}, ${run.idempotencyKey},
        ${columns.hasQueued}, ${columns.approvalDeadline}, ${run.version},
        ${this.session.dialect.json(encodeDoc(run))})
      ON CONFLICT DO NOTHING`);

    return inserted === 1
      ? ok(run)
      : err({
          code: 'duplicate_run',
          message: `Workflow run ${run.idempotencyKey ?? run.id} exists`,
        });
  }

  async get(id: WorkflowRunId): Promise<WorkflowRun | undefined> {
    const [row] = await this.session.all(sql`SELECT doc FROM workflow_runs WHERE id = ${id}`);

    return row ? runFromRow(row) : undefined;
  }

  list(query: WorkflowRunQuery) {
    const where = and([
      query.workflowId ? sql`workflow_id = ${query.workflowId}` : undefined,
      query.status?.length ? sql`status IN (${inList(query.status)})` : undefined,
    ]);

    return newestFirstPage(this.session, sql`workflow_runs`, where, query, runFromRow);
  }

  async update(
    next: WorkflowRun,
    expectedVersion: number,
  ): Promise<Result<WorkflowRun, StaleWorkflowRunError>> {
    const saved = { ...next, version: expectedVersion + 1 };
    const columns = runColumns(saved);
    const changed = await this.session.run(sql`
      UPDATE workflow_runs SET status = ${saved.status}, has_queued = ${columns.hasQueued},
        approval_deadline = ${columns.approvalDeadline}, version = ${saved.version},
        doc = ${this.session.dialect.json(encodeDoc(saved))}
      WHERE id = ${next.id} AND version = ${expectedVersion}`);

    return changed === 1
      ? ok(saved)
      : err({ code: 'stale_run', message: `Workflow run ${next.id} changed concurrently` });
  }

  async findExpiredApprovals({
    now,
    limit,
  }: {
    now: Date;
    limit: number;
  }): Promise<readonly WorkflowRun[]> {
    const rows = await this.session.all(sql`
      SELECT doc FROM workflow_runs WHERE approval_deadline <= ${now.getTime()}
      ORDER BY approval_deadline LIMIT ${limit}`);

    return rows.map(runFromRow);
  }

  async findWithQueuedNodes({ limit }: { limit: number }): Promise<readonly WorkflowRun[]> {
    const rows = await this.session.all(
      sql`SELECT doc FROM workflow_runs WHERE has_queued = 1 ORDER BY id LIMIT ${limit}`,
    );

    return rows.map(runFromRow);
  }
}
