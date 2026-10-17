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
  type StaleRunError,
  err,
  ok,
  type Result,
} from '@cloud-trigger/core';
import type { Collection, Filter } from 'mongodb';

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

export class MongoRunRepository implements RunRepository {
  constructor(private readonly runs: Collection<RunDocument>) {}

  async insert(run: PendingRun): Promise<Result<PendingRun, DomainError<'duplicate_run'>>> {
    try {
      await this.runs.insertOne(toRunDocument(run));

      return ok(run);
    } catch (error: unknown) {
      if (isDuplicateKeyError(error)) {
        return err({
          code: 'duplicate_run',
          message: `Run with key ${run.idempotencyKey ?? run.id} exists`,
        });
      }
      throw error;
    }
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
    if (query.from || query.to) {
      filter.scheduledAt = {
        ...(query.from && { $gte: query.from }),
        ...(query.to && { $lt: query.to }),
      };
    }

    return findNewestFirstPage(this.runs, filter, query, fromRunDocument);
  }

  async transition(previous: Run, next: Run): Promise<Result<Run, StaleRunError>> {
    const res = await this.runs.replaceOne(casFilter(previous), toRunDocument(next));

    return res.matchedCount === 1
      ? ok(next)
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
    const doc = await this.runs.findOneAndUpdate(
      { status: 'pending', availableAt: { $lte: p.now } },
      {
        $set: {
          status: 'running',
          startedAt: p.now,
          lease: { workerId: p.workerId, until: new Date(p.now.getTime() + p.leaseMs) },
          cancelRequested: false,
          updatedAt: p.now,
        },
        $unset: { availableAt: '', overlapSlot: '' },
      },
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
