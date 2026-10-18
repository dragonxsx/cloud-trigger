import {
  type DuplicateWorkflowRunError,
  type NotFoundError,
  type Result,
  type StaleWorkflowRunError,
  type VersionConflictError,
  type Workflow,
  type WorkflowChange,
  type WorkflowId,
  type WorkflowQuery,
  type WorkflowRepository,
  type WorkflowRun,
  type WorkflowRunId,
  type WorkflowRunQuery,
  type WorkflowRunRepository,
  Workflow as WorkflowSchema,
  WorkflowRun as WorkflowRunSchema,
  err,
  ok,
} from '@cloud-trigger/core';
import type { Collection, Filter } from 'mongodb';

import { findNewestFirstPage } from './cursor.js';
import { isDuplicateKeyError } from './errors.js';

export type WorkflowDocument = Omit<Workflow, 'id'> & { _id: string };

export type WorkflowRunDocument = Omit<WorkflowRun, 'id'> & {
  _id: string;
  hasQueued: boolean;
  approvalDeadline: Date | null;
};

const fromWorkflowDocument = (doc: WorkflowDocument): Workflow => {
  const { _id, ...rest } = doc;

  return WorkflowSchema.parse({ ...rest, id: _id });
};

const toRunDocument = (run: WorkflowRun): WorkflowRunDocument => {
  const { id, ...rest } = run;
  const states = Object.values(run.nodes);
  const deadlines = states.flatMap((state) =>
    state.status === 'waiting_approval' && state.deadline !== null
      ? [state.deadline.getTime()]
      : [],
  );

  return {
    ...rest,
    _id: id,
    hasQueued: run.status === 'running' && states.some((state) => state.status === 'queued'),
    approvalDeadline:
      run.status === 'running' && deadlines.length > 0 ? new Date(Math.min(...deadlines)) : null,
  };
};

const fromRunDocument = (doc: WorkflowRunDocument): WorkflowRun => {
  const { _id, hasQueued: _queued, approvalDeadline: _deadline, ...rest } = doc;

  return WorkflowRunSchema.parse({ ...rest, id: _id });
};

export class MongoWorkflowRepository implements WorkflowRepository {
  static readonly collectionName = 'workflows';

  constructor(private readonly workflows: Collection<WorkflowDocument>) {}

  static async ensureIndexes(workflows: Collection<WorkflowDocument>): Promise<void> {
    await workflows.createIndexes([
      { key: { enabled: 1, nextFireAt: 1 }, name: 'due_workflows' },
      { key: { name: 1 }, name: 'name' },
    ]);
  }

  async insert(workflow: Workflow): Promise<void> {
    const { id, ...rest } = workflow;
    await this.workflows.insertOne({ ...rest, _id: id });
  }

  async get(id: WorkflowId): Promise<Workflow | undefined> {
    const doc = await this.workflows.findOne({ _id: id });

    return doc ? fromWorkflowDocument(doc) : undefined;
  }

  list(query: WorkflowQuery) {
    const filter: Filter<WorkflowDocument> = query.search
      ? { name: { $regex: RegExp.escape(query.search), $options: 'i' } }
      : {};

    return findNewestFirstPage(this.workflows, filter, query, fromWorkflowDocument);
  }

  async update(
    id: WorkflowId,
    change: WorkflowChange,
    expectedVersion: number,
  ): Promise<Result<Workflow, VersionConflictError | NotFoundError>> {
    const doc = await this.workflows.findOneAndUpdate(
      { _id: id, version: expectedVersion },
      {
        $set: {
          ...change.spec,
          inlineJobIds: { ...change.inlineJobIds },
          nextFireAt: change.nextFireAt,
          updatedAt: change.updatedAt,
          version: expectedVersion + 1,
        },
      },
      { returnDocument: 'after' },
    );
    if (doc) {
      return ok(fromWorkflowDocument(doc));
    }
    const exists = await this.workflows.countDocuments({ _id: id }, { limit: 1 });

    return exists
      ? err({ code: 'version_conflict', message: `Workflow ${id} was modified concurrently` })
      : err({ code: 'not_found', message: `Workflow ${id} not found` });
  }

  async delete(id: WorkflowId): Promise<boolean> {
    return (await this.workflows.deleteOne({ _id: id })).deletedCount === 1;
  }

  async findDue({ now, limit }: { now: Date; limit: number }): Promise<readonly Workflow[]> {
    const docs = await this.workflows
      .find({ enabled: true, nextFireAt: { $ne: null, $lte: now } })
      .sort({ nextFireAt: 1 })
      .limit(limit)
      .toArray();

    return docs.map(fromWorkflowDocument);
  }

  async advanceSchedule(
    id: WorkflowId,
    { from, to }: { from: Date; to: Date | null },
  ): Promise<boolean> {
    const result = await this.workflows.updateOne(
      { _id: id, nextFireAt: from },
      { $set: { nextFireAt: to } },
    );

    return result.modifiedCount === 1;
  }
}

export class MongoWorkflowRunRepository implements WorkflowRunRepository {
  static readonly collectionName = 'workflow_runs';

  constructor(private readonly runs: Collection<WorkflowRunDocument>) {}

  static async ensureIndexes(runs: Collection<WorkflowRunDocument>): Promise<void> {
    await runs.createIndexes([
      {
        key: { idempotencyKey: 1 },
        name: 'idempotency',
        unique: true,
        partialFilterExpression: { idempotencyKey: { $type: 'string' } },
      },
      { key: { workflowId: 1, _id: -1 }, name: 'workflow_runs' },
      { key: { status: 1, _id: -1 }, name: 'status' },
      {
        key: { approvalDeadline: 1 },
        name: 'approval_deadline',
        partialFilterExpression: { approvalDeadline: { $type: 'date' } },
      },
      {
        key: { hasQueued: 1 },
        name: 'queued_nodes',
        partialFilterExpression: { hasQueued: true },
      },
    ]);
  }

  async insert(run: WorkflowRun): Promise<Result<WorkflowRun, DuplicateWorkflowRunError>> {
    try {
      await this.runs.insertOne(toRunDocument(run));

      return ok(run);
    } catch (error: unknown) {
      if (isDuplicateKeyError(error)) {
        return err({
          code: 'duplicate_run',
          message: `Workflow run ${run.idempotencyKey ?? run.id} exists`,
        });
      }
      throw error;
    }
  }

  async get(id: WorkflowRunId): Promise<WorkflowRun | undefined> {
    const doc = await this.runs.findOne({ _id: id });

    return doc ? fromRunDocument(doc) : undefined;
  }

  list(query: WorkflowRunQuery) {
    const filter: Filter<WorkflowRunDocument> = {
      ...(query.workflowId !== undefined && { workflowId: query.workflowId }),
      ...(query.status !== undefined &&
        query.status.length > 0 && { status: { $in: [...query.status] } }),
    };

    return findNewestFirstPage(this.runs, filter, query, fromRunDocument);
  }

  async update(
    next: WorkflowRun,
    expectedVersion: number,
  ): Promise<Result<WorkflowRun, StaleWorkflowRunError>> {
    const saved = { ...next, version: expectedVersion + 1 };
    const result = await this.runs.replaceOne(
      { _id: next.id, version: expectedVersion },
      toRunDocument(saved),
    );

    return result.modifiedCount === 1
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
    const docs = await this.runs
      .find({ approvalDeadline: { $ne: null, $lte: now } })
      .sort({ approvalDeadline: 1 })
      .limit(limit)
      .toArray();

    return docs.map(fromRunDocument);
  }

  async findWithQueuedNodes({ limit }: { limit: number }): Promise<readonly WorkflowRun[]> {
    const docs = await this.runs.find({ hasQueued: true }).sort({ _id: 1 }).limit(limit).toArray();

    return docs.map(fromRunDocument);
  }
}
