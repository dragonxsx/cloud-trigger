import {
  type Job,
  type JobId,
  type JobQuery,
  type JobRepository,
  JobSpec,
  type NotFoundError,
  type PendingRun,
  type JobUpdate,
  type ScheduleState,
  type ScheduleStore,
  type StaleClaimError,
  type VersionConflictError,
  err,
  ok,
  type Result,
} from '@cloud-trigger/core';
import {
  type ClientSession,
  type Collection,
  type Document,
  type Filter,
  type MongoClient,
} from 'mongodb';

import { findNewestFirstPage } from './cursor.js';
import {
  type JobDocument,
  type RunDocument,
  fromJobDocument,
  toJobDocument,
  toRunDocument,
} from './documents.js';

const SPEC_FIELDS = new Set(Object.keys(JobSpec.shape));

// Copy JobSpec keys only so edits can't overwrite scheduler/pause state.
const userEditableFields = (spec: JobSpec): Record<string, unknown> =>
  Object.fromEntries(Object.entries(spec).filter(([key]) => SPEC_FIELDS.has(key)));

export class MongoJobRepository implements JobRepository {
  constructor(private readonly jobs: Collection<JobDocument>) {}

  async insert(job: Job): Promise<void> {
    await this.jobs.insertOne(toJobDocument(job));
  }

  async get(id: JobId): Promise<Job | undefined> {
    const doc = await this.jobs.findOne({ _id: id });

    return doc ? fromJobDocument(doc) : undefined;
  }

  async list(query: JobQuery) {
    const filter: Filter<JobDocument> = {};
    if (query.search) {
      filter.name = { $regex: RegExp.escape(query.search), $options: 'i' };
    }
    if (query.tag) {
      filter.tags = query.tag;
    }
    if (query.groupId) {
      filter.groupId = query.groupId;
    }
    if (query.enabled !== undefined) {
      filter.enabled = query.enabled;
    }
    if (query.slaBreached !== undefined) {
      filter.slaBreachedAt = query.slaBreached ? { $ne: null } : null;
    }

    return findNewestFirstPage(this.jobs, filter, query, fromJobDocument);
  }

  async update(
    id: JobId,
    update: JobUpdate,
    expectedVersion: number,
  ): Promise<Result<Job, VersionConflictError | NotFoundError>> {
    const { reschedule } = update;
    const doc = await this.jobs.findOneAndUpdate(
      {
        _id: id,
        version: expectedVersion,
        ...(reschedule && {
          'schedule.nextFireAt': reschedule.basedOn.nextFireAt,
          'schedule.fireCount': reschedule.basedOn.fireCount,
        }),
      },
      {
        $set: {
          ...userEditableFields(update.spec),
          updatedAt: update.updatedAt,
          version: expectedVersion + 1,
          schedulerLease: null,
          ...(reschedule && { 'schedule.nextFireAt': reschedule.nextFireAt }),
          ...(update.upstreamJobIds && { upstreamJobIds: [...update.upstreamJobIds] }),
        },
      },
      { returnDocument: 'after' },
    );
    if (doc) {
      return ok(fromJobDocument(doc));
    }
    const exists = await this.jobs.countDocuments({ _id: id }, { limit: 1 });

    return exists
      ? err({ code: 'version_conflict', message: `Job ${id} was modified concurrently` })
      : err({ code: 'not_found', message: `Job ${id} not found` });
  }

  async delete(id: JobId): Promise<boolean> {
    const res = await this.jobs.deleteOne({ _id: id });

    return res.deletedCount === 1;
  }

  async patchSchedule(
    id: JobId,
    patch: Partial<ScheduleState>,
    extra: { pausedReason?: string | null; slaBreachedAt?: Date | null } = {},
  ): Promise<void> {
    const set: Record<string, unknown> = Object.fromEntries(
      Object.entries(patch).map(([key, value]) => [`schedule.${key}`, value]),
    );
    if (extra.pausedReason !== undefined) {
      set['pausedReason'] = extra.pausedReason;
    }
    if (extra.slaBreachedAt !== undefined) {
      set['slaBreachedAt'] = extra.slaBreachedAt;
    }
    if (Object.keys(set).length > 0) {
      await this.jobs.updateOne({ _id: id }, { $set: set });
    }
  }

  async findDependants(jobId: JobId): Promise<readonly Job[]> {
    const docs = await this.jobs.find({ upstreamJobIds: jobId }).sort({ _id: 1 }).toArray();

    return docs.map(fromJobDocument);
  }

  async findByName(name: string): Promise<readonly Job[]> {
    const docs = await this.jobs.find({ name }).sort({ _id: 1 }).toArray();

    return docs.map(fromJobDocument);
  }

  async findStaleJobs(p: { now: Date; limit: number }): Promise<readonly Job[]> {
    const docs = await this.jobs
      .find({ enabled: true, slaBreachedAt: null, 'schedule.successDeadline': { $lte: p.now } })
      .sort({ 'schedule.successDeadline': 1 })
      .limit(p.limit)
      .toArray();

    return docs.map(fromJobDocument);
  }

  async updateSlaState(
    job: Job,
    update: { slaBreachedAt: Date | null; successDeadline: Date | null },
  ): Promise<boolean> {
    const res = await this.jobs.updateOne(
      {
        _id: job.id,
        slaBreachedAt: job.slaBreachedAt,
        'schedule.successDeadline': job.schedule.successDeadline,
      },
      {
        $set: {
          slaBreachedAt: update.slaBreachedAt,
          'schedule.successDeadline': update.successDeadline,
        },
      },
    );

    return res.matchedCount === 1;
  }

  async recordFailure(id: JobId, p: { pauseAfter?: number | undefined }): Promise<void> {
    const failures = '$schedule.consecutiveFailures';
    const pipeline: Document[] = [
      { $set: { 'schedule.consecutiveFailures': { $add: [failures, 1] } } },
    ];
    if (p.pauseAfter !== undefined) {
      pipeline.push({
        $set: {
          pausedReason: {
            $cond: [
              { $and: [{ $eq: ['$pausedReason', null] }, { $gte: [failures, p.pauseAfter] }] },
              { $concat: ['Auto-paused after ', { $toString: failures }, ' consecutive failures'] },
              '$pausedReason',
            ],
          },
        },
      });
    }
    await this.jobs.updateOne({ _id: id }, pipeline);
  }
}

export class MongoScheduleStore implements ScheduleStore {
  constructor(
    private readonly client: MongoClient,
    private readonly jobs: Collection<JobDocument>,
    private readonly runs: Collection<RunDocument>,
  ) {}

  async claimDue(p: {
    now: Date;
    ownerId: string;
    leaseMs: number;
    limit: number;
  }): Promise<readonly Job[]> {
    const claimed: Job[] = [];
    for (let i = 0; i < p.limit; i++) {
      const doc = await this.jobs.findOneAndUpdate(
        {
          enabled: true,
          pausedReason: null,
          'schedule.nextFireAt': { $lte: p.now },
          $or: [{ schedulerLease: null }, { 'schedulerLease.until': { $lt: p.now } }],
        },
        {
          $set: {
            schedulerLease: { owner: p.ownerId, until: new Date(p.now.getTime() + p.leaseMs) },
          },
        },
        { sort: { 'schedule.nextFireAt': 1 }, returnDocument: 'after' },
      );
      if (!doc) {
        break;
      }
      claimed.push(fromJobDocument(doc));
    }

    return claimed;
  }

  async commitFire(p: {
    jobId: JobId;
    jobVersion: number;
    ownerId: string;
    now: Date;
    runs: readonly PendingRun[];
    schedule: Pick<ScheduleState, 'nextFireAt' | 'lastFiredAt' | 'fireCount'>;
  }): Promise<Result<readonly PendingRun[], StaleClaimError>> {
    // The transaction fences inserts with the lease and job version.
    return this.client.withSession((session) =>
      session.withTransaction(async () => {
        const claimed = await this.jobs.updateOne(
          {
            _id: p.jobId,
            version: p.jobVersion,
            'schedulerLease.owner': p.ownerId,
            'schedulerLease.until': { $gt: p.now },
          },
          {
            $set: {
              'schedule.nextFireAt': p.schedule.nextFireAt,
              'schedule.lastFiredAt': p.schedule.lastFiredAt,
              'schedule.fireCount': p.schedule.fireCount,
              schedulerLease: null,
            },
          },
          { session },
        );
        if (claimed.matchedCount === 0) {
          await session.abortTransaction();

          return err({
            code: 'stale_claim',
            message: `Lost the scheduler claim on job ${p.jobId}`,
          });
        }
        const inserted: PendingRun[] = [];
        for (const run of p.runs) {
          if (await this.#insertUnlessDuplicate(run, session)) {
            inserted.push(run);
          }
        }

        return ok(inserted);
      }),
    );
  }

  // Inside a transaction a duplicate-key error aborts everything, so dedupe with an upsert instead.
  async #insertUnlessDuplicate(run: PendingRun, session: ClientSession): Promise<boolean> {
    const doc = toRunDocument(run);
    if (run.idempotencyKey === null) {
      await this.runs.insertOne(doc, { session });

      return true;
    }
    const res = await this.runs.updateOne(
      { idempotencyKey: run.idempotencyKey },
      { $setOnInsert: doc },
      { upsert: true, session },
    );

    return res.upsertedCount === 1;
  }
}
