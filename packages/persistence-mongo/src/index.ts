import {
  type DecisionLog,
  type EventBus,
  type GroupRepository,
  type RateLimiter,
  type JobRepository,
  type NotificationOutbox,
  type RunAnalytics,
  type RunQueue,
  type RunRepository,
  ResultAsync,
  type ScheduleStore,
  toError,
} from '@cloud-trigger/core';
import { type Db, MongoClient } from 'mongodb';

import { MongoRunAnalytics, type RunMetricDocument } from './analytics.js';
import { type DecisionDocument, MongoDecisionLog } from './decisions.js';
import type { JobDocument, RunDocument } from './documents.js';
import { MongoChangeStreamEventBus } from './events.js';
import {
  type GroupDocument,
  MongoGroupRepository,
  MongoRateLimiter,
  type RateLimitDocument,
} from './groups.js';
import { MongoJobRepository, MongoScheduleStore } from './jobs.js';
import { MongoNotificationOutbox, type NotificationDocument } from './notifications.js';
import { type FireKeyDocument, MongoRunQueue, MongoRunRepository } from './runs.js';

export {
  MongoChangeStreamEventBus,
  MongoDecisionLog,
  MongoGroupRepository,
  MongoJobRepository,
  MongoNotificationOutbox,
  MongoRateLimiter,
  MongoRunAnalytics,
  MongoRunQueue,
  MongoRunRepository,
  MongoScheduleStore,
};

export interface MongoPersistenceOptions {
  readonly uri: string;
  readonly dbName?: string;
  readonly analyticsUri?: string | undefined;
  readonly analyticsDbName?: string | undefined;
  readonly runRetentionDays?: number;
  readonly metricsRetentionDays?: number;
  readonly decisionRetentionDays?: number;
  readonly onEventBusError?: (error: unknown) => void;
}

export interface MongoPersistence {
  readonly jobs: JobRepository;
  readonly schedule: ScheduleStore;
  readonly runs: RunRepository;
  readonly queue: RunQueue;
  readonly analytics: RunAnalytics;
  readonly outbox: NotificationOutbox;
  readonly groups: GroupRepository;
  readonly rateLimiter: RateLimiter;
  readonly decisions: DecisionLog;
  readonly events: EventBus & { start(): void };
  migrate(): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

async function ensureIndexes(db: Db, runRetentionDays: number): Promise<void> {
  await db.collection<JobDocument>('jobs').createIndexes([
    { key: { enabled: 1, pausedReason: 1, 'schedule.nextFireAt': 1 }, name: 'due_jobs' },
    { key: { tags: 1 }, name: 'tags' },
    { key: { groupId: 1 }, name: 'group' },
    { key: { upstreamJobIds: 1 }, name: 'upstream_jobs' },
    { key: { name: 1 }, name: 'name' },
    {
      key: { 'schedule.successDeadline': 1 },
      name: 'success_deadline',
      partialFilterExpression: { 'schedule.successDeadline': { $type: 'date' } },
    },
    { key: { slaBreachedAt: 1 }, name: 'sla_breached' },
  ]);
  await db.collection<RunDocument>('runs').createIndexes([
    { key: { status: 1, availableAt: 1 }, name: 'claimable' },
    { key: { status: 1, 'lease.until': 1 }, name: 'expired_leases' },
    { key: { jobId: 1, status: 1, _id: -1 }, name: 'job_runs' },
    { key: { scheduledAt: -1 }, name: 'scheduled_at' },
    { key: { status: 1, acknowledgedAt: 1, _id: -1 }, name: 'failed_inbox' },
    {
      key: { rateLimitKey: 1, status: 1 },
      name: 'rate_limit_slot',
      partialFilterExpression: { rateLimitKey: { $type: 'string' } },
    },
    {
      key: { slaDeadline: 1 },
      name: 'sla_deadline',
      partialFilterExpression: { slaDeadline: { $type: 'date' } },
    },
    {
      key: { idempotencyKey: 1 },
      name: 'idempotency',
      unique: true,
      partialFilterExpression: { idempotencyKey: { $type: 'string' } },
    },
    { key: { finishedAt: 1 }, name: 'retention', expireAfterSeconds: runRetentionDays * 86_400 },
    {
      key: { overlapSlot: 1 },
      name: 'overlap_slot',
      unique: true,
      partialFilterExpression: { overlapSlot: { $type: 'string' } },
    },
  ]);
}

export async function createMongoPersistence(
  options: MongoPersistenceOptions,
): Promise<MongoPersistence> {
  const clientOptions = { ignoreUndefined: true, appName: 'cloud-trigger' } as const;
  const client = await MongoClient.connect(options.uri, clientOptions);
  const analyticsClient = options.analyticsUri
    ? await MongoClient.connect(options.analyticsUri, clientOptions)
    : client;
  const db = client.db(options.dbName);
  const analyticsDb = analyticsClient.db(options.analyticsDbName ?? options.dbName);

  const jobs = db.collection<JobDocument>('jobs');
  const runs = db.collection<RunDocument>('runs');
  const metrics = analyticsDb.collection<RunMetricDocument>(MongoRunAnalytics.collectionName);
  const groups = db.collection<GroupDocument>(MongoGroupRepository.collectionName);
  const rateLimits = db.collection<RateLimitDocument>(MongoRateLimiter.collectionName);
  const outbox = db.collection<NotificationDocument>(MongoNotificationOutbox.collectionName);
  const events = new MongoChangeStreamEventBus(runs, jobs, options.onEventBusError);

  return {
    jobs: new MongoJobRepository(jobs),
    schedule: new MongoScheduleStore(client, jobs, runs),
    runs: new MongoRunRepository(
      runs,
      db.collection<FireKeyDocument>(MongoRunRepository.fireKeysCollectionName),
    ),
    queue: new MongoRunQueue(runs),
    analytics: new MongoRunAnalytics(metrics),
    outbox: new MongoNotificationOutbox(outbox),
    groups: new MongoGroupRepository(groups),
    rateLimiter: new MongoRateLimiter(rateLimits),
    decisions: new MongoDecisionLog(
      db.collection<DecisionDocument>(MongoDecisionLog.collectionName),
    ),
    events,
    async migrate() {
      await ensureIndexes(db, options.runRetentionDays ?? 30);
      await MongoNotificationOutbox.ensureIndexes(outbox);
      await MongoGroupRepository.ensureIndexes(groups);
      await MongoDecisionLog.ensureIndexes(db, options.decisionRetentionDays ?? 14);
      await MongoRunAnalytics.ensureCollection(analyticsDb, options.metricsRetentionDays ?? 90);
    },
    ping: async () => (await ResultAsync.fromPromise(db.command({ ping: 1 }), toError)).isOk(),
    async close() {
      await events.close();
      await client.close();
      if (analyticsClient !== client) {
        await analyticsClient.close();
      }
    },
  };
}
