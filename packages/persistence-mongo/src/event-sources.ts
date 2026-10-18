import type { EventSourceLeaseRequest, EventSourceLeases } from '@cloud-trigger/core';
import type { Collection } from 'mongodb';

import { isDuplicateKeyError } from './errors.js';

export interface EventSourceLeaseDocument {
  _id: string;
  owner: string;
  until: Date;
}

export class MongoEventSourceLeases implements EventSourceLeases {
  static readonly collectionName = 'event_sources';

  constructor(private readonly leases: Collection<EventSourceLeaseDocument>) {}

  async claim({ key, ownerId, now, leaseMs }: EventSourceLeaseRequest): Promise<boolean> {
    try {
      await this.leases.updateOne(
        { _id: key, $or: [{ owner: ownerId }, { until: { $lte: now } }] },
        { $set: { owner: ownerId, until: new Date(now.getTime() + leaseMs) } },
        { upsert: true },
      );

      return true;
    } catch (error: unknown) {
      if (isDuplicateKeyError(error)) {
        return false;
      }
      throw error;
    }
  }

  async release({ key, ownerId }: { key: string; ownerId: string }): Promise<void> {
    await this.leases.deleteOne({ _id: key, owner: ownerId });
  }
}
