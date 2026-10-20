import { DEFAULT_RETENTION, type Persistence, type RetentionPolicy } from '@cloud-trigger/core';
import { sql } from 'drizzle-orm';

import { SqlRunAnalytics } from './analytics.js';
import { SqlApiKeyRepository, SqlAuthSettingsStore, SqlUserRepository } from './auth.js';
import { SqlConnectionRepository } from './connections.js';
import { SqlDecisionLog } from './decisions.js';
import { SqlEnvironmentRepository } from './environments.js';
import { SqlEventSourceLeases } from './event-sources.js';
import type { ChangeSink, ClosableEventBus } from './events.js';
import { SqlGroupRepository, SqlRateLimiter } from './groups.js';
import { SqlJobRepository, SqlScheduleStore } from './jobs.js';
import { SqlNotificationOutbox } from './notifications.js';
import { SqlRunQueue, SqlRunRepository, loadRunChanged, runFromRow } from './runs.js';
import { type RawDatabase, type SqlDialect, SqlSession } from './session.js';
import { SqlWorkflowRepository, SqlWorkflowRunRepository } from './workflows.js';

export * from './codec.js';
export * from './compile.js';
export * from './dialects.js';
export * from './events.js';
export * from './session.js';
export * from './tables.js';
export { loadRunChanged, runFromRow };
export {
  SqlApiKeyRepository,
  SqlAuthSettingsStore,
  SqlConnectionRepository,
  SqlUserRepository,
  SqlDecisionLog,
  SqlEnvironmentRepository,
  SqlEventSourceLeases,
  SqlGroupRepository,
  SqlJobRepository,
  SqlNotificationOutbox,
  SqlRateLimiter,
  SqlRunAnalytics,
  SqlRunQueue,
  SqlRunRepository,
  SqlScheduleStore,
  SqlWorkflowRepository,
  SqlWorkflowRunRepository,
};

export interface SqlAdapterOptions {
  readonly retention?: RetentionPolicy | undefined;
  readonly sweepIntervalMs?: number | undefined;
  readonly onEventBusError?: ((error: unknown) => void) | undefined;
}

export interface SqlPersistenceOptions {
  readonly session: SqlSession;
  readonly events: ClosableEventBus;
  readonly changes?: ChangeSink | undefined;
  readonly migrate: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly retention?: RetentionPolicy | undefined;
  readonly sweepIntervalMs?: number | undefined;
  readonly onSweepError?: ((error: unknown) => void) | undefined;
}

export interface SqlPersistence extends Persistence {
  readonly sweep: (now: Date) => Promise<void>;
}

const DAY_MS = 86_400_000;

export const createSession = (db: RawDatabase, dialect: SqlDialect): SqlSession =>
  new SqlSession(db, dialect);

export function createSqlPersistence(options: SqlPersistenceOptions): SqlPersistence {
  const { session, changes } = options;
  const retention = options.retention ?? DEFAULT_RETENTION;
  const sweep = async (now: Date): Promise<void> => {
    const at = now.getTime();
    await session.run(
      sql`DELETE FROM runs WHERE finished_at IS NOT NULL AND finished_at < ${at - retention.runDays * DAY_MS}`,
    );
    await session.run(
      sql`DELETE FROM run_metrics WHERE ts < ${at - retention.metricsDays * DAY_MS}`,
    );
    await session.run(
      sql`DELETE FROM schedule_decisions WHERE at < ${at - retention.decisionDays * DAY_MS}`,
    );
  };
  const timer =
    options.sweepIntervalMs === undefined
      ? undefined
      : setInterval(() => {
          sweep(new Date()).catch((error: unknown) => options.onSweepError?.(error));
        }, options.sweepIntervalMs);
  timer?.unref();

  return {
    jobs: new SqlJobRepository(session, changes),
    connections: new SqlConnectionRepository(session),
    environments: new SqlEnvironmentRepository(session),
    schedule: new SqlScheduleStore(session, changes),
    runs: new SqlRunRepository(session, changes),
    queue: new SqlRunQueue(session, changes),
    analytics: new SqlRunAnalytics(session),
    outbox: new SqlNotificationOutbox(session),
    groups: new SqlGroupRepository(session),
    rateLimiter: new SqlRateLimiter(session),
    decisions: new SqlDecisionLog(session),
    eventSources: new SqlEventSourceLeases(session),
    workflows: new SqlWorkflowRepository(session),
    workflowRuns: new SqlWorkflowRunRepository(session),
    authSettings: new SqlAuthSettingsStore(session),
    users: new SqlUserRepository(session),
    apiKeys: new SqlApiKeyRepository(session),
    events: options.events,
    unitOfWork: session,
    migrate: options.migrate,
    ping: async () => {
      try {
        await session.all(sql`SELECT 1 AS ok`);

        return true;
      } catch {
        return false;
      }
    },
    sweep,
    close: async () => {
      if (timer) {
        clearInterval(timer);
      }
      await options.events.close();
      await options.close();
    },
  };
}
