import {
  type NotificationDelivery,
  NotificationDelivery as NotificationDeliverySchema,
  type NotificationOutbox,
  type RunId,
  failedDeliveryFields,
} from '@cloud-trigger/core';
import { type Collection, type Filter, MongoBulkWriteError } from 'mongodb';

import { type Stored, documentParser, toDocument } from './documents.js';
import { isDuplicateKeyError } from './errors.js';

export type NotificationDocument = Stored<NotificationDelivery>;

const fromDocument = documentParser(NotificationDeliverySchema);

const heldBy = (claimed: NotificationDelivery): Filter<NotificationDocument> => ({
  _id: claimed.id,
  status: 'sending',
  'lease.workerId': claimed.lease?.workerId,
  'lease.until': claimed.lease?.until,
});

export class MongoNotificationOutbox implements NotificationOutbox {
  static readonly collectionName = 'notifications_outbox';

  constructor(private readonly outbox: Collection<NotificationDocument>) {}

  static async ensureIndexes(outbox: Collection<NotificationDocument>): Promise<void> {
    await outbox.createIndexes([
      { key: { status: 1, availableAt: 1 }, name: 'due' },
      { key: { status: 1, 'lease.until': 1 }, name: 'expired_leases' },
      { key: { key: 1 }, name: 'idempotency', unique: true },
      { key: { runId: 1, createdAt: 1 }, name: 'run' },
    ]);
  }

  async enqueue(entries: readonly NotificationDelivery[]): Promise<number> {
    if (entries.length === 0) {
      return 0;
    }
    try {
      const res = await this.outbox.insertMany(
        entries.map((entry) => toDocument(entry)),
        { ordered: false },
      );

      return res.insertedCount;
    } catch (error: unknown) {
      if (error instanceof MongoBulkWriteError && isDuplicateKeyError(error)) {
        return error.result.insertedCount;
      }
      throw error;
    }
  }

  async claimNext(p: { workerId: string; now: Date; leaseMs: number }) {
    const doc = await this.outbox.findOneAndUpdate(
      {
        $or: [
          { status: 'pending', availableAt: { $lte: p.now } },
          { status: 'sending', 'lease.until': { $lt: p.now } },
        ],
      },
      {
        $set: {
          status: 'sending',
          lease: { workerId: p.workerId, until: new Date(p.now.getTime() + p.leaseMs) },
          updatedAt: p.now,
        },
        $inc: { attempts: 1 },
      },
      { sort: { availableAt: 1 }, returnDocument: 'after' },
    );

    return doc ? fromDocument(doc) : undefined;
  }

  async complete(claimed: NotificationDelivery, now: Date): Promise<boolean> {
    const res = await this.outbox.updateOne(heldBy(claimed), {
      $set: { status: 'delivered', lease: null, deliveredAt: now, updatedAt: now },
    });

    return res.matchedCount === 1;
  }

  async fail(
    claimed: NotificationDelivery,
    p: { error: string; retryAt: Date | null; now: Date },
  ): Promise<boolean> {
    const res = await this.outbox.updateOne(heldBy(claimed), {
      $set: { ...failedDeliveryFields(claimed, p), lease: null },
    });

    return res.matchedCount === 1;
  }

  async listByRun(runId: RunId): Promise<readonly NotificationDelivery[]> {
    const docs = await this.outbox.find({ runId }).sort({ createdAt: 1, ruleIndex: 1 }).toArray();

    return docs.map(fromDocument);
  }

  async listOpenByConnection(key: string): Promise<readonly NotificationDelivery[]> {
    const docs = await this.outbox
      .find({ status: { $in: ['pending', 'sending'] }, 'notifier.connection.key': key })
      .sort({ createdAt: 1, _id: 1 })
      .toArray();

    return docs.map(fromDocument);
  }
}
