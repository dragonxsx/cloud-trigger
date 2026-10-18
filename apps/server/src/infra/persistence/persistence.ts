import { type Logger, type Persistence, assertNever } from '@cloud-trigger/core';
import { createMongoPersistence } from '@cloud-trigger/persistence-mongo';
import { createPostgresPersistence } from '@cloud-trigger/persistence-postgres';
import { createSqlitePersistence } from '@cloud-trigger/persistence-sqlite';

import type { AppConfig } from '../../config/config.js';

const SWEEP_INTERVAL_MS = 10 * 60_000;

const required = (value: string | undefined, name: string): string => {
  if (value === undefined) {
    throw new Error(`${name} is required`);
  }

  return value;
};

export async function createPersistence(config: AppConfig, logger: Logger): Promise<Persistence> {
  const retention = {
    runRetentionDays: config.RUN_RETENTION_DAYS,
    metricsRetentionDays: config.METRICS_RETENTION_DAYS,
    decisionRetentionDays: config.DECISION_RETENTION_DAYS,
  };
  const onEventBusError = (error: unknown) =>
    logger.warn('Event stream error; reconnecting', { err: error });
  switch (config.DB_DRIVER) {
    case 'mongo':
      return createMongoPersistence({
        uri: required(config.MONGO_URI, 'MONGO_URI'),
        dbName: config.MONGO_DB,
        analyticsUri: config.ANALYTICS_MONGO_URI,
        analyticsDbName: config.ANALYTICS_MONGO_DB,
        ...retention,
        onEventBusError,
      });
    case 'postgres':
      return createPostgresPersistence({
        url: required(config.POSTGRES_URL, 'POSTGRES_URL'),
        maxConnections: config.POSTGRES_MAX_CONNECTIONS,
        sweepIntervalMs: SWEEP_INTERVAL_MS,
        ...retention,
        onEventBusError,
      });
    case 'sqlite':
      return createSqlitePersistence({
        path: config.SQLITE_PATH,
        sweepIntervalMs: SWEEP_INTERVAL_MS,
        ...retention,
        onEventBusError,
      });
    default:
      return assertNever(config.DB_DRIVER);
  }
}
