import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Mutex } from '@cloud-trigger/core';
import {
  type CompiledQuery,
  InProcessEventBus,
  type RawDatabase,
  type RawExecutor,
  type Row,
  type SqlPersistence,
  createSession,
  createSqlPersistence,
  loadRunChanged,
  sqliteDialect,
} from '@cloud-trigger/persistence-sql';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { z } from 'zod';

export interface SqlitePersistenceOptions {
  /** A file path, or `:memory:` for tests. */
  readonly path: string;
  readonly runRetentionDays?: number;
  readonly metricsRetentionDays?: number;
  readonly decisionRetentionDays?: number;
  readonly sweepIntervalMs?: number;
  readonly guardLeaseMs?: number;
  readonly onEventBusError?: (error: unknown) => void;
}

export type SqlitePersistence = SqlPersistence;

const Param = z.union([z.string(), z.number(), z.bigint(), z.null()]);
const params = (query: CompiledQuery) => query.params.map((value) => Param.parse(value));
const RowShape = z.record(z.string(), z.unknown());

const executorFor = (db: Database.Database): RawExecutor => ({
  all: (query) => {
    const statement = db.prepare(query.text);
    if (!statement.reader) {
      statement.run(...params(query));

      return Promise.resolve([]);
    }
    const rows: unknown[] = statement.all(...params(query));

    return Promise.resolve(rows.map((row): Row => RowShape.parse(row)));
  },
  run: (query) => Promise.resolve(db.prepare(query.text).run(...params(query)).changes),
});

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
const GUARD_KEY = 'sqlite:single-node';

export function createSqlitePersistence(options: SqlitePersistenceOptions): SqlitePersistence {
  if (options.path !== ':memory:') {
    mkdirSync(dirname(options.path), { recursive: true });
  }
  const sqlite = new Database(options.path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  const raw = executorFor(sqlite);
  const mutex = new Mutex();
  const db: RawDatabase = {
    all: (query) => mutex.lock(() => raw.all(query)),
    run: (query) => mutex.lock(() => raw.run(query)),
    transaction: (work) =>
      mutex.lock(async () => {
        sqlite.exec('BEGIN IMMEDIATE');
        try {
          const result = await work(raw);
          sqlite.exec('COMMIT');

          return result;
        } catch (error: unknown) {
          sqlite.exec('ROLLBACK');
          throw error;
        }
      }),
  };
  const session = createSession(db, sqliteDialect);
  const events = new InProcessEventBus(
    (id) => loadRunChanged(session, id),
    options.onEventBusError ?? (() => undefined),
  );
  const ownerId = randomUUID();
  const leaseMs = options.guardLeaseMs ?? 30_000;
  let guard: NodeJS.Timeout | undefined;

  const persistence = createSqlPersistence({
    session,
    events,
    changes: events,
    retention: {
      runDays: options.runRetentionDays ?? 30,
      metricsDays: options.metricsRetentionDays ?? 90,
      decisionDays: options.decisionRetentionDays ?? 14,
    },
    sweepIntervalMs: options.sweepIntervalMs,
    migrate: async () => {
      await mutex.lock(() => {
        migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS });

        return Promise.resolve();
      });
      await claimSingleNode();
    },
    close: async () => {
      if (guard) {
        clearInterval(guard);
        await persistence.eventSources.release({ key: GUARD_KEY, ownerId });
      }
      sqlite.close();
    },
  });

  const claim = () =>
    persistence.eventSources.claim({ key: GUARD_KEY, ownerId, now: new Date(), leaseMs });

  async function claimSingleNode(): Promise<void> {
    if (!(await claim())) {
      throw new Error(
        `Another process is using the SQLite database ${options.path}; SQLite supports a single node`,
      );
    }
    guard = setInterval(
      () => {
        claim().catch((error: unknown) => options.onEventBusError?.(error));
      },
      Math.max(1_000, Math.floor(leaseMs / 3)),
    );
    guard.unref();
  }

  return persistence;
}
