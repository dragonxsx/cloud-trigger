import {
  type AcquireResult,
  type ConflictError,
  DEFAULT_CONCURRENCY_RETRY_MS,
  Group,
  type GroupId,
  type GroupQuery,
  type GroupRepository,
  type GroupUpdate,
  type NotFoundError,
  type RateLimit,
  type RateLimiter,
  type Result,
  type VersionConflictError,
  acquireResult,
  bucketCapacity,
  err,
  groupUpdateFields,
  nameTaken,
  ok,
} from '@cloud-trigger/core';
import type { Collection, Document, Filter } from 'mongodb';
import { z } from 'zod';

import { findNewestFirstPage } from './cursor.js';
import { type Stored, documentParser, toDocument } from './documents.js';
import {
  casMissed,
  caseInsensitiveMatch,
  isDuplicateKeyError,
  unlessDuplicateKey,
} from './errors.js';

export type GroupDocument = Stored<Group>;

const fromDocument = documentParser(Group);
const CASE_INSENSITIVE = { locale: 'en', strength: 2 };

export class MongoGroupRepository implements GroupRepository {
  static readonly collectionName = 'groups';

  constructor(private readonly groups: Collection<GroupDocument>) {}

  static async ensureIndexes(groups: Collection<GroupDocument>): Promise<void> {
    await groups.createIndexes([
      { key: { name: 1 }, name: 'name', unique: true, collation: CASE_INSENSITIVE },
      { key: { 'connectionRefs.key': 1, 'connectionRefs.endpoint': 1 }, name: 'connections' },
    ]);
  }

  async insert(group: Group): Promise<Result<Group, ConflictError>> {
    const inserted = await unlessDuplicateKey(
      () => this.groups.insertOne(toDocument(group)),
      () => nameTaken('group', group.name),
    );

    return inserted.map(() => group);
  }

  async get(id: GroupId): Promise<Group | undefined> {
    const doc = await this.groups.findOne({ _id: id });

    return doc ? fromDocument(doc) : undefined;
  }

  async findByName(name: string): Promise<Group | undefined> {
    const doc = await this.groups.findOne({ name }, { collation: CASE_INSENSITIVE });

    return doc ? fromDocument(doc) : undefined;
  }

  list(query: GroupQuery) {
    const filter: Filter<GroupDocument> = query.search
      ? { name: caseInsensitiveMatch(query.search) }
      : {};

    return findNewestFirstPage(this.groups, filter, query, fromDocument);
  }

  async update(
    id: GroupId,
    update: GroupUpdate,
    expectedVersion: number,
  ): Promise<Result<Group, VersionConflictError | NotFoundError | ConflictError>> {
    const updated = await unlessDuplicateKey(
      () =>
        this.groups.findOneAndUpdate(
          { _id: id, version: expectedVersion },
          { $set: groupUpdateFields(update, expectedVersion) },
          { returnDocument: 'after' },
        ),
      () => nameTaken('group', update.spec.name),
    );
    if (updated.isErr()) {
      return err(updated.error);
    }

    return updated.value ? ok(fromDocument(updated.value)) : casMissed(this.groups, 'Group', id);
  }

  async delete(id: GroupId): Promise<boolean> {
    const res = await this.groups.deleteOne({ _id: id });

    return res.deletedCount === 1;
  }

  async findByConnection(key: string, endpoint?: string): Promise<readonly Group[]> {
    const docs = await this.groups
      .find({
        connectionRefs: { $elemMatch: { key, ...(endpoint !== undefined && { endpoint }) } },
      })
      .sort({ _id: 1 })
      .toArray();

    return docs.map(fromDocument);
  }
}

export interface RateLimitDocument {
  _id: string;
  tokens?: number;
  refilledAt?: Date;
  running?: number;
  granted?: boolean;
  touchedAt?: Date;
}

const AcquiredDocument = z.object({
  tokens: z.number().optional(),
  running: z.number().default(0),
  granted: z.boolean(),
});

const HeldDocument = z.object({ _id: z.string(), running: z.number() });

export class MongoRateLimiter implements RateLimiter {
  static readonly collectionName = 'rate_limits';

  constructor(
    private readonly limits: Collection<RateLimitDocument>,
    private readonly concurrencyRetryMs = DEFAULT_CONCURRENCY_RETRY_MS,
  ) {}

  async tryAcquire(key: string, limit: RateLimit, now: Date): Promise<AcquireResult> {
    const doc = await this.#acquire(key, limit, now).catch((error: unknown) => {
      if (isDuplicateKeyError(error)) {
        return this.#acquire(key, limit, now);
      }
      throw error;
    });
    const state = AcquiredDocument.parse(doc);

    return acquireResult(
      limit,
      { granted: state.granted, running: state.running, tokens: state.tokens ?? null },
      now,
      this.concurrencyRetryMs,
    );
  }

  async release(key: string, now: Date): Promise<void> {
    await this.limits.updateOne({ _id: key }, [
      {
        $set: {
          running: { $max: [0, { $subtract: [{ $ifNull: ['$running', 0] }, 1] }] },
          touchedAt: now,
        },
      },
    ]);
  }

  async reconcile(key: string, p: { running: number; idleSince: Date }): Promise<boolean> {
    const res = await this.limits.updateOne(
      { _id: key, touchedAt: { $lt: p.idleSince }, running: { $ne: p.running } },
      { $set: { running: p.running } },
    );

    return res.matchedCount === 1;
  }

  async listHeld(): Promise<readonly { key: string; running: number }[]> {
    const docs = await this.limits
      .find({ running: { $gt: 0 } }, { projection: { running: 1 } })
      .toArray();

    return docs.map((doc) => {
      const held = HeldDocument.parse(doc);

      return { key: held._id, running: held.running };
    });
  }

  #acquire(key: string, limit: RateLimit, now: Date) {
    const rate = limit.perSecond;
    const capacity = bucketCapacity(limit);
    const max = limit.maxConcurrent;
    const elapsedSeconds = {
      $divide: [{ $subtract: [now, { $ifNull: ['$refilledAt', now] }] }, 1_000],
    };
    const pipeline: Document[] = [
      {
        $set: {
          _running: { $ifNull: ['$running', 0] },
          _tokens:
            capacity === undefined || rate === undefined
              ? null
              : {
                  $min: [
                    capacity,
                    {
                      $add: [
                        { $ifNull: ['$tokens', capacity] },
                        { $multiply: [elapsedSeconds, rate] },
                      ],
                    },
                  ],
                },
        },
      },
      {
        $set: {
          granted: {
            $and: [
              max === undefined ? true : { $lt: ['$_running', max] },
              capacity === undefined ? true : { $gte: ['$_tokens', 1] },
            ],
          },
        },
      },
      {
        $set: {
          running:
            max === undefined
              ? '$_running'
              : { $cond: ['$granted', { $add: ['$_running', 1] }, '$_running'] },
          tokens:
            capacity === undefined
              ? '$$REMOVE'
              : { $cond: ['$granted', { $subtract: ['$_tokens', 1] }, '$_tokens'] },
          refilledAt: now,
          touchedAt: { $cond: ['$granted', now, '$touchedAt'] },
        },
      },
      { $unset: ['_running', '_tokens'] },
    ];

    return this.limits.findOneAndUpdate({ _id: key }, pipeline, {
      upsert: true,
      returnDocument: 'after',
    });
  }
}
