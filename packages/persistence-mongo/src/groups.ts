import {
  type AcquireResult,
  type ConflictError,
  type Group,
  Group as GroupSchema,
  type GroupId,
  type GroupQuery,
  type GroupRepository,
  type GroupSpec,
  type NotFoundError,
  type RateLimit,
  type RateLimiter,
  type Result,
  type VersionConflictError,
  err,
  ok,
} from '@cloud-trigger/core';
import type { Collection, Document, Filter } from 'mongodb';
import { z } from 'zod';

import { findNewestFirstPage } from './cursor.js';
import { isDuplicateKeyError } from './errors.js';

export type GroupDocument = Omit<Group, 'id'> & { _id: string };

const fromDocument = (doc: GroupDocument): Group => {
  const { _id, ...rest } = doc;

  return GroupSchema.parse({ ...rest, id: _id });
};

const nameTaken = (name: string): ConflictError => ({
  code: 'conflict',
  message: `A group named "${name}" already exists`,
});

export class MongoGroupRepository implements GroupRepository {
  static readonly collectionName = 'groups';

  constructor(private readonly groups: Collection<GroupDocument>) {}

  static async ensureIndexes(groups: Collection<GroupDocument>): Promise<void> {
    await groups.createIndexes([
      { key: { name: 1 }, name: 'name', unique: true, collation: { locale: 'en', strength: 2 } },
    ]);
  }

  async insert(group: Group): Promise<Result<Group, ConflictError>> {
    const { id, ...rest } = group;
    try {
      await this.groups.insertOne({ ...rest, _id: id });

      return ok(group);
    } catch (error: unknown) {
      if (isDuplicateKeyError(error)) {
        return err(nameTaken(group.name));
      }
      throw error;
    }
  }

  async get(id: GroupId): Promise<Group | undefined> {
    const doc = await this.groups.findOne({ _id: id });

    return doc ? fromDocument(doc) : undefined;
  }

  async findByName(name: string): Promise<Group | undefined> {
    const doc = await this.groups.findOne({ name }, { collation: { locale: 'en', strength: 2 } });

    return doc ? fromDocument(doc) : undefined;
  }

  list(query: GroupQuery) {
    const filter: Filter<GroupDocument> = query.search
      ? { name: { $regex: RegExp.escape(query.search), $options: 'i' } }
      : {};

    return findNewestFirstPage(this.groups, filter, query, fromDocument);
  }

  async update(
    id: GroupId,
    update: { spec: GroupSpec; updatedAt: Date },
    expectedVersion: number,
  ): Promise<Result<Group, VersionConflictError | NotFoundError | ConflictError>> {
    try {
      const doc = await this.groups.findOneAndUpdate(
        { _id: id, version: expectedVersion },
        { $set: { ...update.spec, updatedAt: update.updatedAt, version: expectedVersion + 1 } },
        { returnDocument: 'after' },
      );
      if (doc) {
        return ok(fromDocument(doc));
      }
    } catch (error: unknown) {
      if (isDuplicateKeyError(error)) {
        return err(nameTaken(update.spec.name));
      }
      throw error;
    }
    const exists = await this.groups.countDocuments({ _id: id }, { limit: 1 });

    return exists
      ? err({ code: 'version_conflict', message: `Group ${id} was modified concurrently` })
      : err({ code: 'not_found', message: `Group ${id} not found` });
  }

  async delete(id: GroupId): Promise<boolean> {
    const res = await this.groups.deleteOne({ _id: id });

    return res.deletedCount === 1;
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
    private readonly concurrencyRetryMs = 250,
  ) {}

  async tryAcquire(key: string, limit: RateLimit, now: Date): Promise<AcquireResult> {
    const doc = await this.#acquire(key, limit, now).catch((error: unknown) => {
      if (isDuplicateKeyError(error)) {
        return this.#acquire(key, limit, now);
      }
      throw error;
    });
    const state = AcquiredDocument.parse(doc);
    if (state.granted) {
      return { ok: true, holdsSlot: limit.maxConcurrent !== undefined };
    }
    const waits = [
      limit.maxConcurrent !== undefined && state.running >= limit.maxConcurrent
        ? this.concurrencyRetryMs
        : 0,
      limit.perSecond !== undefined && (state.tokens ?? 0) < 1
        ? Math.ceil(((1 - (state.tokens ?? 0)) / limit.perSecond) * 1_000)
        : 0,
    ];

    return { ok: false, retryAt: new Date(now.getTime() + Math.max(1, ...waits)) };
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
    const capacity = rate === undefined ? undefined : Math.max(1, rate);
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
