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
  duplicateWorkflowRun,
  err,
  notFound,
  ok,
  savedWorkflowRun,
  staleWorkflowRun,
  versionConflict,
  workflowChangeFields,
  workflowRunIndex,
} from '@cloud-trigger/core';
import { sql } from 'drizzle-orm';

import { docParser } from './codec.js';
import { and, containsInsensitive, inList, newestFirstPage } from './query.js';
import { type RowValues, assignments, insertInto } from './rows.js';
import type { SqlSession } from './session.js';

const workflowFromRow = docParser(Workflow);
const runFromRow = docParser(WorkflowRun);

const workflowColumns = (workflow: Workflow): RowValues<'workflows'> => ({
  id: workflow.id,
  name: workflow.name,
  enabled: workflow.enabled,
  environment: workflow.environment,
  next_fire_at: workflow.nextFireAt,
  version: workflow.version,
  created_at: workflow.createdAt,
  doc: workflow,
});

const runColumns = (run: WorkflowRun): RowValues<'workflow_runs'> => {
  const index = workflowRunIndex(run);

  return {
    id: run.id,
    workflow_id: run.workflowId,
    status: run.status,
    idempotency_key: run.idempotencyKey,
    has_queued: index.hasQueued,
    approval_deadline: index.approvalDeadline,
    version: run.version,
    doc: run,
  };
};

export class SqlWorkflowRepository implements WorkflowRepository {
  constructor(private readonly session: SqlSession) {}

  async insert(workflow: Workflow): Promise<void> {
    await this.session.run(insertInto(this.session, 'workflows', workflowColumns(workflow)));
  }

  async get(id: WorkflowId): Promise<Workflow | undefined> {
    const [row] = await this.session.all(sql`SELECT doc FROM workflows WHERE id = ${id}`);

    return row ? workflowFromRow(row) : undefined;
  }

  list(query: WorkflowQuery) {
    const where = and([containsInsensitive(this.session.dialect, 'name', query.search)]);

    return newestFirstPage(this.session, sql`workflows`, where, query, workflowFromRow);
  }

  async update(
    id: WorkflowId,
    change: WorkflowChange,
    expectedVersion: number,
  ): Promise<Result<Workflow, VersionConflictError | NotFoundError>> {
    const current = await this.get(id);
    if (!current) {
      return err(notFound('Workflow', id));
    }
    const next = Workflow.parse({ ...current, ...workflowChangeFields(change, expectedVersion) });
    const { id: _id, created_at: _createdAt, ...changes } = workflowColumns(next);
    const changed = await this.session.run(sql`
      UPDATE workflows SET ${assignments(this.session, 'workflows', changes)}
      WHERE id = ${id} AND version = ${expectedVersion}`);

    return changed === 1 ? ok(next) : err(versionConflict('Workflow', id));
  }

  async delete(id: WorkflowId): Promise<boolean> {
    return (await this.session.run(sql`DELETE FROM workflows WHERE id = ${id}`)) === 1;
  }

  async findByEnvironment(environment: string): Promise<readonly Workflow[]> {
    const rows = await this.session.all(
      sql`SELECT doc FROM workflows WHERE environment = ${environment} ORDER BY id`,
    );

    return rows.map(workflowFromRow);
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
        UPDATE workflows SET ${assignments(this.session, 'workflows', {
          next_fire_at: to,
          doc: next,
        })}
        WHERE id = ${id} AND next_fire_at = ${from.getTime()}`);

      return changed === 1;
    });
  }
}

export class SqlWorkflowRunRepository implements WorkflowRunRepository {
  constructor(private readonly session: SqlSession) {}

  async insert(run: WorkflowRun): Promise<Result<WorkflowRun, DuplicateWorkflowRunError>> {
    const inserted = await this.session.run(
      sql`${insertInto(this.session, 'workflow_runs', runColumns(run))} ON CONFLICT DO NOTHING`,
    );

    return inserted === 1 ? ok(run) : err(duplicateWorkflowRun(run));
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
    const saved = savedWorkflowRun(next, expectedVersion);
    const {
      id: _id,
      workflow_id: _workflowId,
      idempotency_key: _key,
      ...changes
    } = runColumns(saved);
    const changed = await this.session.run(sql`
      UPDATE workflow_runs SET ${assignments(this.session, 'workflow_runs', changes)}
      WHERE id = ${next.id} AND version = ${expectedVersion}`);

    return changed === 1 ? ok(saved) : err(staleWorkflowRun(next.id));
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
