import {
  type DecisionLog,
  type JobId,
  ScheduleDecision,
  type ScheduleDecision as ScheduleDecisionType,
} from '@cloud-trigger/core';
import type { Collection, Db } from 'mongodb';

import { ensureTtlIndex } from './ttl.js';

export type DecisionDocument = ScheduleDecisionType;

export class MongoDecisionLog implements DecisionLog {
  static readonly collectionName = 'schedule_decisions';

  constructor(private readonly decisions: Collection<DecisionDocument>) {}

  static async ensureIndexes(db: Db, retentionDays: number): Promise<void> {
    await db
      .collection<DecisionDocument>(MongoDecisionLog.collectionName)
      .createIndexes([{ key: { jobId: 1, at: -1 }, name: 'job_recent' }]);
    await ensureTtlIndex(db, MongoDecisionLog.collectionName, {
      name: 'retention',
      key: { at: 1 },
      days: retentionDays,
    });
  }

  async record(decision: ScheduleDecisionType): Promise<void> {
    await this.decisions.insertOne({ ...decision });
  }

  async listRecent(jobId: JobId, p: { before: Date; limit: number }) {
    const docs = await this.decisions
      .find({ jobId, at: { $lte: p.before } }, { projection: { _id: 0 } })
      .sort({ at: -1 })
      .limit(p.limit)
      .toArray();

    return docs.map((doc) => ScheduleDecision.parse(doc));
  }
}
