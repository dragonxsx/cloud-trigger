import { type Logger, type Persistence, assertNever } from '@cloud-trigger/core';
import { createMongoPersistence } from '@cloud-trigger/persistence-mongo';
import { createPostgresPersistence } from '@cloud-trigger/persistence-postgres';
import { createSqlitePersistence } from '@cloud-trigger/persistence-sqlite';

import type { AppConfig, DatabaseConfig } from '../../config/config.js';

const SWEEP_INTERVAL_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 10_000;

export interface PersistenceOptions {
  readonly retention?:
    | {
        readonly runRetentionDays: number;
        readonly metricsRetentionDays: number;
        readonly decisionRetentionDays: number;
      }
    | undefined;
  readonly sweepIntervalMs?: number | undefined;
  readonly serverSelectionTimeoutMs?: number | undefined;
  readonly onEventBusError: (error: unknown) => void;
}

export const retentionOf = (config: AppConfig) => ({
  runRetentionDays: config.RUN_RETENTION_DAYS,
  metricsRetentionDays: config.METRICS_RETENTION_DAYS,
  decisionRetentionDays: config.DECISION_RETENTION_DAYS,
});

export async function openPersistence(
  database: DatabaseConfig,
  options: PersistenceOptions,
): Promise<Persistence> {
  const { retention, onEventBusError, sweepIntervalMs } = options;
  switch (database.driver) {
    case 'mongo':
      return createMongoPersistence({
        uri: database.uri,
        dbName: database.dbName,
        analyticsUri: database.analyticsUri,
        analyticsDbName: database.analyticsDbName,
        serverSelectionTimeoutMs: options.serverSelectionTimeoutMs,
        ...retention,
        onEventBusError,
      });
    case 'postgres':
      return createPostgresPersistence({
        url: database.url,
        maxConnections: database.maxConnections,
        ...(sweepIntervalMs !== undefined && { sweepIntervalMs }),
        ...retention,
        onEventBusError,
      });
    case 'sqlite':
      return createSqlitePersistence({
        path: database.path,
        ...(sweepIntervalMs !== undefined && { sweepIntervalMs }),
        ...retention,
        onEventBusError,
      });
    default:
      return assertNever(database);
  }
}

export function createPersistence(
  database: DatabaseConfig,
  config: AppConfig,
  logger: Logger,
): Promise<Persistence> {
  return openPersistence(database, {
    retention: retentionOf(config),
    sweepIntervalMs: SWEEP_INTERVAL_MS,
    onEventBusError: (error: unknown) =>
      logger.warn('Event stream error; reconnecting', { err: error }),
  });
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const withTimeout = <T>(work: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`No answer within ${ms / 1_000} s`)), ms).unref();
    }),
  ]);

export async function probeDatabase(database: DatabaseConfig): Promise<string | undefined> {
  try {
    const persistence = await withTimeout(
      openPersistence(database, {
        serverSelectionTimeoutMs: PROBE_TIMEOUT_MS,
        onEventBusError: () => undefined,
      }),
      PROBE_TIMEOUT_MS,
    );
    try {
      return (await withTimeout(persistence.ping(), PROBE_TIMEOUT_MS))
        ? undefined
        : 'The database did not answer a ping';
    } finally {
      await persistence.close().catch(() => undefined);
    }
  } catch (error: unknown) {
    return describeError(error);
  }
}
