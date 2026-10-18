import {
  type DomainError,
  type JobId,
  type PendingRun,
  type Run,
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
  type Result,
} from '@cloud-trigger/core';
import type { Collection, Document, Filter } from 'mongodb';

import { findNewestFirstPage } from './cursor.js';
import {
  type RunDocument,
  fromRunDocument,
  fromRunningDocument,
  toRunDocument,
} from './documents.js';
import { isDuplicateKeyError } from './errors.js';

const SUCCESS_LIKE: readonly RunStatus[] = ['succeeded', 'cancelled', 'skipped'];
const FAILURE_LIKE: readonly RunStatus[] = ['failed', 'timed_out'];

const replaceKeepingLateness = (next: Run): Document[] => {
  const doc = toRunDocument(next);

  return [
    {
      $replaceWith: {
        $mergeObjects: [
          { $literal: doc },
          {
            late: { $or: [{ $eq: ['$late', true] }, doc.late] },
            lateReasons: {
              $cond: [{ $eq: ['$late', true] }, '$lateReasons', { $literal: doc.lateReasons }],
            },
            slaDeadline: { $cond: [{ $eq: ['$late', true] }, null, { $literal: doc.slaDeadline }] },
          },
        ],
      },
    },
  ];
};

const casFilter = (previous: Run): Filter<RunDocument> =>
  previous.status === 'running'
    ? {
        _id: previous.id,
        status: 'running',
        updatedAt: previous.updatedAt,
        'lease.workerId': previous.lease.workerId,
        'lease.until': previous.lease.until,
      }
    : { _id: previous.id, status: previous.status, updatedAt: previous.updatedAt };

export interface FireKeyDocument {
  _id: string;
  jobId: string;
  createdAt: Date;
}

const duplicateRun = (run: PendingRun): DomainError<'duplicate_run'> => ({
  code: 'duplicate_run',
  message: `Run with key ${run.idempotencyKey ?? run.id} exists`,
});

export class MongoRunRepository implements RunRepository {
  static readonly fireKeysCollectionName = 'fire_keys';

  constructor(
    private readonly runs: Collection<RunDocument>,
    private readonly fireKeys: Collection<FireKeyDocument>,
  ) {}

  async insert(
    run: PendingRun,
    opts: { durableKey?: boolean } = {},
  ): Promise<Result<PendingRun, DomainError<'duplicate_run'>>> {
    const durableKey = opts.durableKey === true ? run.idempotencyKey : null;
    if (durableKey !== null && (await this.fireKeys.countDocuments({ _id: durableKey }))) {
      return err(duplicateRun(run));
    }
    try {
      await this.runs.insertOne(toRunDocument(run));
    } catch (error: unknown) {
      if (isDuplicateKeyError(error)) {
        return err(duplicateRun(run));
      }
      throw error;
    }
    if (durableKey !== null) {
      await this.fireKeys.updateOne(
        { _id: durableKey },
        { $setOnInsert: { jobId: run.jobId, createdAt: run.createdAt } },
        { upsert: true },
      );
    }

    return ok(run);
  }

  async get(id: RunId): Promise<Run | undefined> {
    const doc = await this.runs.findOne({ _id: id });

    return doc ? fromRunDocument(doc) : undefined;
  }

  async list(query: RunQuery) {
    const filter: Filter<RunDocument> = {};
    if (query.jobId) {
      filter.jobId = query.jobId;
    }
    if (query.status?.length) {
      filter.status = { $in: [...query.status] };
    }
    if (query.reason) {
      filter.reason = query.reason;
    }
    if (query.late !== undefined) {
      filter.late = query.late;
    }
    if (query.acknowledged !== undefined) {
      filter.acknowledgedAt = query.acknowledged ? { $ne: null } : null;
    }
    if (query.from || query.to) {
      filter.scheduledAt = {
        ...(query.from && { $gte: query.from }),
        ...(query.to && { $lt: query.to }),
      };
    }

    return findNewestFirstPage(this.runs, filter, query, fromRunDocument);
  }

  async transition(previous: Run, next: Run): Promise<Result<Run, StaleRunError>> {
    const doc = await this.runs.findOneAndUpdate(
      casFilter(previous),
      replaceKeepingLateness(next),
      {
        returnDocument: 'after',
      },
    );

    return doc
      ? ok(fromRunDocument(doc))
      : err({ code: 'stale_run', message: `Run ${previous.id} changed since it was read` });
  }

  countByStatus(jobId: JobId, statuses: readonly RunStatus[]): Promise<number> {
    return this.runs.countDocuments({ jobId, status: { $in: [...statuses] } });
  }

  async findByStatus(jobId: JobId, statuses: readonly RunStatus[]): Promise<readonly Run[]> {
    const docs = await this.runs
      .find({ jobId, status: { $in: [...statuses] } })
      .sort({ _id: 1 })
      .toArray();

    return docs.map(fromRunDocument);
  }

  countHoldingSlot(key: string): Promise<number> {
    return this.runs.countDocuments({ status: 'running', rateLimitKey: key });
  }

  async markSlotHeld(run: RunningRun, key: string): Promise<boolean> {
    const res = await this.runs.updateOne(
      { _id: run.id, status: 'running', 'lease.workerId': run.lease.workerId },
      { $set: { rateLimitKey: key } },
    );

    return res.matchedCount === 1;
  }

  async acknowledge(ids: readonly RunId[], at: Date): Promise<number> {
    const res = await this.runs.updateMany(
      { _id: { $in: [...ids] }, status: { $in: [...FAILURE_LIKE] }, acknowledgedAt: null },
      { $set: { acknowledgedAt: at } },
    );

    return res.modifiedCount;
  }

  async findLateCandidates(p: { now: Date; limit: number }) {
    const docs = await this.runs
      .find({ status: { $in: ['pending', 'running'] }, late: false, slaDeadline: { $lte: p.now } })
      .sort({ slaDeadline: 1 })
      .limit(p.limit)
      .toArray();

    return docs
      .map(fromRunDocument)
      .filter((run) => run.status === 'pending' || run.status === 'running');
  }

  async updateSla(run: PendingRun | RunningRun, update: SlaUpdate): Promise<boolean> {
    const res = await this.runs.updateOne(
      { _id: run.id, status: run.status, late: false, slaDeadline: run.slaDeadline },
      {
        $set: {
          late: update.late,
          lateReasons: [...update.lateReasons],
          slaDeadline: update.slaDeadline,
        },
      },
    );

    return res.matchedCount === 1;
  }

  async prune(jobId: JobId, keep: { succeeded: number; failed: number }): Promise<number> {
    let deleted = 0;
    for (const [statuses, count] of [
      [SUCCESS_LIKE, keep.succeeded],
      [FAILURE_LIKE, keep.failed],
    ] as const) {
      const stale = await this.runs
        .find({ jobId, status: { $in: [...statuses] } }, { projection: { _id: 1 } })
        .sort({ _id: -1 })
        .skip(count)
        .toArray();
      if (stale.length > 0) {
        const res = await this.runs.deleteMany({ _id: { $in: stale.map((d) => d._id) } });
        deleted += res.deletedCount;
      }
    }

    return deleted;
  }
}

export class MongoRunQueue implements RunQueue {
  constructor(private readonly runs: Collection<RunDocument>) {}

  async claimNext(p: {
    workerId: string;
    now: Date;
    leaseMs: number;
  }): Promise<RunningRun | undefined> {
    const startDeadlineMissed = {
      $and: [{ $eq: [{ $type: '$slaDeadline' }, 'date'] }, { $lte: ['$slaDeadline', p.now] }],
    };
    const durationDeadline = {
      $cond: [{ $isNumber: '$slaMaxDurationMs' }, { $add: [p.now, '$slaMaxDurationMs'] }, null],
    };
    const doc = await this.runs.findOneAndUpdate(
      { status: 'pending', availableAt: { $lte: p.now } },
      [
        {
          $set: {
            status: 'running',
            startedAt: p.now,
            lease: {
              workerId: { $literal: p.workerId },
              until: new Date(p.now.getTime() + p.leaseMs),
            },
            cancelRequested: false,
            rateLimitKey: null,
            updatedAt: p.now,
            slaDeadline: {
              $cond: [
                { $eq: ['$late', true] },
                null,
                { $cond: [startDeadlineMissed, '$slaDeadline', durationDeadline] },
              ],
            },
          },
        },
        { $unset: ['availableAt', 'overlapSlot'] },
      ],
      { sort: { availableAt: 1 }, returnDocument: 'after' },
    );

    return doc ? fromRunningDocument(doc) : undefined;
  }

  async renewLease(p: { runId: RunId; workerId: string; until: Date }) {
    const doc = await this.runs.findOneAndUpdate(
      { _id: p.runId, status: 'running', 'lease.workerId': p.workerId },
      { $set: { 'lease.until': p.until } },
      { returnDocument: 'after', projection: { cancelRequested: 1 } },
    );
    const cancelRequested = doc !== null && 'cancelRequested' in doc && doc.cancelRequested;

    return { renewed: doc !== null, cancelRequested };
  }

  async requestCancel(runId: RunId): Promise<boolean> {
    const res = await this.runs.updateOne(
      { _id: runId, status: 'running' },
      { $set: { cancelRequested: true } },
    );

    return res.matchedCount === 1;
  }

  async findExpired(p: { now: Date; limit: number }): Promise<readonly RunningRun[]> {
    const docs = await this.runs
      .find({ status: 'running', 'lease.until': { $lt: p.now } })
      .limit(p.limit)
      .toArray();

    return docs.map(fromRunningDocument);
  }

  // Leaves `updatedAt` and the lease untouched, so the caller's snapshot still passes CAS.
  async acquireExecution(run: RunningRun): Promise<boolean> {
    try {
      const res = await this.runs.updateOne(
        { _id: run.id, status: 'running', 'lease.workerId': run.lease.workerId },
        { $set: { overlapSlot: `${run.jobId}:exec` } },
      );

      return res.matchedCount === 1;
    } catch (error: unknown) {
      if (isDuplicateKeyError(error)) {
        return false;
      }
      throw error;
    }
  }

  async buffer(
    previous: RunningRun,
    next: PendingRun,
  ): Promise<Result<PendingRun, StaleRunError | DomainError<'buffer_full'>>> {
    try {
      const res = await this.runs.replaceOne(casFilter(previous), {
        ...toRunDocument(next),
        overlapSlot: `${next.jobId}:buffer`,
      });

      return res.matchedCount === 1
        ? ok(next)
        : err({ code: 'stale_run', message: `Run ${previous.id} changed since it was read` });
    } catch (error: unknown) {
      if (isDuplicateKeyError(error)) {
        return err({
          code: 'buffer_full',
          message: `Job ${next.jobId} already has a buffered run`,
        });
      }
      throw error;
    }
  }
}
