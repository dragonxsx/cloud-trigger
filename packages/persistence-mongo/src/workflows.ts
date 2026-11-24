import {
  type DuplicateWorkflowRunError,
  type NotFoundError,
  type Result,
  type StaleWorkflowRunError,
  type VersionConflictError,
  type Workflow,
  type WorkflowChange,
  type WorkflowFire,
  type WorkflowId,
  type WorkflowQuery,
  type WorkflowRepository,
  type WorkflowRun,
  type WorkflowRunId,
  type WorkflowRunQuery,
  type WorkflowRunIndex,
  type WorkflowRunRepository,
  type WorkflowScheduleBasis,
  Workflow as WorkflowSchema,
  WorkflowRun as WorkflowRunSchema,
  duplicateWorkflowRun,
  err,
  ok,
  savedWorkflowRun,
  staleWorkflowRun,
  workflowChangeFields,
  workflowRunIndex,
} from '@cloud-trigger/core';
import type { Collection, Filter, MongoClient } from 'mongodb';

import { findNewestFirstPage } from './cursor.js';
import { type Stored, documentParser, toDocument } from './documents.js';
import { casMissed, caseInsensitiveMatch, unlessDuplicateKey } from './errors.js';

export type WorkflowDocument = Stored<Workflow>;
export type WorkflowRunDocument = Stored<WorkflowRun> & WorkflowRunIndex;

const fromWorkflowDocument = documentParser(WorkflowSchema);
const fromRunDocument = documentParser(WorkflowRunSchema);

const toRunDocument = (run: WorkflowRun): WorkflowRunDocument => ({
  ...toDocument(run),
  ...workflowRunIndex(run),
});

const scheduleBasisFilter = (
  basedOn: WorkflowScheduleBasis | undefined,
): Filter<WorkflowDocument> =>
  basedOn === undefined
    ? {}
    : {
        nextFireAt: basedOn.nextFireAt,
        fireCount: basedOn.fireCount === 0 ? { $not: { $gt: 0 } } : basedOn.fireCount,
      };

export class MongoWorkflowRepository implements WorkflowRepository {
  static readonly collectionName = 'workflows';

  constructor(
    private readonly client: MongoClient,
    private readonly workflows: Collection<WorkflowDocument>,
    private readonly runs: Collection<WorkflowRunDocument>,
  ) {}

  static async ensureIndexes(workflows: Collection<WorkflowDocument>): Promise<void> {
    await workflows.createIndexes([
      { key: { enabled: 1, nextFireAt: 1 }, name: 'due_workflows' },
      { key: { name: 1 }, name: 'name' },
      {
        key: { environment: 1 },
        name: 'environment',
        partialFilterExpression: { environment: { $type: 'string' } },
      },
    ]);
  }

  async insert(workflow: Workflow): Promise<void> {
    await this.workflows.insertOne(toDocument(workflow));
  }

  async get(id: WorkflowId): Promise<Workflow | undefined> {
    const doc = await this.workflows.findOne({ _id: id });

    return doc ? fromWorkflowDocument(doc) : undefined;
  }

  list(query: WorkflowQuery) {
    const filter: Filter<WorkflowDocument> = query.search
      ? { name: caseInsensitiveMatch(query.search) }
      : {};

    return findNewestFirstPage(this.workflows, filter, query, fromWorkflowDocument);
  }

  async update(
    id: WorkflowId,
    change: WorkflowChange,
    expectedVersion: number,
  ): Promise<Result<Workflow, VersionConflictError | NotFoundError>> {
    const doc = await this.workflows.findOneAndUpdate(
      { _id: id, version: expectedVersion, ...scheduleBasisFilter(change.basedOn) },
      { $set: workflowChangeFields(change, expectedVersion) },
      { returnDocument: 'after' },
    );

    return doc ? ok(fromWorkflowDocument(doc)) : casMissed(this.workflows, 'Workflow', id);
  }

  async delete(id: WorkflowId): Promise<boolean> {
    return (await this.workflows.deleteOne({ _id: id })).deletedCount === 1;
  }

  async findByEnvironment(environment: string): Promise<readonly Workflow[]> {
    const docs = await this.workflows.find({ environment }).sort({ _id: 1 }).toArray();

    return docs.map(fromWorkflowDocument);
  }

  async findDue({ now, limit }: { now: Date; limit: number }): Promise<readonly Workflow[]> {
    const docs = await this.workflows
      .find({ enabled: true, nextFireAt: { $ne: null, $lte: now } })
      .sort({ nextFireAt: 1 })
      .limit(limit)
      .toArray();

    return docs.map(fromWorkflowDocument);
  }

  async fireSchedule(fire: WorkflowFire): Promise<boolean> {
    return this.client.withSession((session) =>
      session.withTransaction(async () => {
        const advanced = await this.workflows.updateOne(
          { _id: fire.id, enabled: true, nextFireAt: fire.from },
          {
            $set: {
              nextFireAt: fire.schedule.nextFireAt,
              lastFiredAt: fire.schedule.lastFiredAt,
              fireCount: fire.schedule.fireCount,
            },
          },
          { session },
        );
        if (advanced.matchedCount === 0) {
          await session.abortTransaction();

          return false;
        }
        const doc = toRunDocument(fire.run);
        if (fire.run.idempotencyKey === null) {
          await this.runs.insertOne(doc, { session });

          return true;
        }
        const inserted = await this.runs.updateOne(
          { idempotencyKey: fire.run.idempotencyKey },
          { $setOnInsert: doc },
          { upsert: true, session },
        );

        return inserted.upsertedCount === 1;
      }),
    );
  }
}

export class MongoWorkflowRunRepository implements WorkflowRunRepository {
  static readonly collectionName = 'workflow_runs';

  constructor(private readonly runs: Collection<WorkflowRunDocument>) {}

  static async ensureIndexes(
    runs: Collection<WorkflowRunDocument>,
    retentionDays: number,
  ): Promise<void> {
    await runs.createIndexes([
      {
        key: { finishedAt: 1 },
        name: 'retention',
        expireAfterSeconds: retentionDays * 86_400,
      },
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
    const inserted = await unlessDuplicateKey(
      () => this.runs.insertOne(toRunDocument(run)),
      () => duplicateWorkflowRun(run),
    );

    return inserted.map(() => run);
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
    const saved = savedWorkflowRun(next, expectedVersion);
    const result = await this.runs.replaceOne(
      { _id: next.id, version: expectedVersion },
      toRunDocument(saved),
    );

    return result.modifiedCount === 1 ? ok(saved) : err(staleWorkflowRun(next.id));
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

  async findWithQueuedNodes({
    limit,
    after,
  }: {
    limit: number;
    after?: WorkflowRunId | undefined;
  }): Promise<readonly WorkflowRun[]> {
    const docs = await this.runs
      .find({ hasQueued: true, ...(after !== undefined && { _id: { $gt: after } }) })
      .sort({ _id: 1 })
      .limit(limit)
      .toArray();

    return docs.map(fromRunDocument);
  }
}
