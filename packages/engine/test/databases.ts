import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Persistence, assertNever } from '@cloud-trigger/core';
import { createMongoPersistence } from '@cloud-trigger/persistence-mongo';
import { createPostgresPersistence } from '@cloud-trigger/persistence-postgres';
import { createSqlitePersistence } from '@cloud-trigger/persistence-sqlite';
import { MongoDBContainer } from '@testcontainers/mongodb';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import Database from 'better-sqlite3';
import { MongoClient } from 'mongodb';
import postgres from 'postgres';
import { z } from 'zod';

export const Adapter = z.enum(['mongo', 'postgres', 'sqlite']);
export type Adapter = z.output<typeof Adapter>;

export const ADAPTER: Adapter = Adapter.default('mongo').parse(process.env['ENGINE_DB']);

export const ALL_TABLES = [
  'jobs',
  'job_tags',
  'job_upstreams',
  'runs',
  'fire_keys',
  'groups',
  'rate_limits',
  'notifications_outbox',
  'schedule_decisions',
  'run_metrics',
  'event_sources',
  'workflows',
  'workflow_runs',
  'auth_settings',
  'users',
  'api_keys',
] as const;

export interface TestDatabase {
  readonly persistence: Persistence;
  /** Empties the named collections or tables; every one when omitted. */
  readonly clear: (tables?: readonly string[]) => Promise<void>;
  readonly stop: () => Promise<void>;
}

async function startMongo(name: string): Promise<TestDatabase> {
  const container = await new MongoDBContainer('mongo:8').start();
  const uri = `${container.getConnectionString()}?directConnection=true`;
  const persistence = await createMongoPersistence({ uri, dbName: name });
  await persistence.migrate();
  const admin = await MongoClient.connect(uri);

  return {
    persistence,
    clear: async (tables) => {
      const collections = await admin.db(name).collections();
      await Promise.all(
        collections
          .filter((c) => !c.collectionName.startsWith('system.'))
          .filter((c) => tables === undefined || tables.includes(c.collectionName))
          .map((c) => c.deleteMany({})),
      );
    },
    stop: async () => {
      await persistence.close();
      await admin.close();
      await container.stop();
    },
  };
}

async function startPostgres(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer('postgres:18-alpine').start();
  const url = container.getConnectionUri();
  const persistence = createPostgresPersistence({ url, maxConnections: 20 });
  await persistence.migrate();
  const admin = postgres(url, { max: 1, onnotice: () => undefined });
  const known = new Set<string>(ALL_TABLES);

  return {
    persistence,
    clear: async (tables) => {
      const names = (tables ?? ALL_TABLES).filter((table) => known.has(table));
      await admin.unsafe(`TRUNCATE ${names.join(', ')}`);
    },
    stop: async () => {
      await persistence.close();
      await admin.end();
      await container.stop();
    },
  };
}

async function startSqlite(): Promise<TestDatabase> {
  const dir = mkdtempSync(join(tmpdir(), 'ct-engine-'));
  const path = join(dir, 'engine.db');
  const persistence = createSqlitePersistence({ path });
  await persistence.migrate();
  const admin = new Database(path);
  admin.pragma('busy_timeout = 5000');
  const known = new Set<string>(ALL_TABLES);

  return {
    persistence,
    clear: (tables) => {
      for (const table of (tables ?? ALL_TABLES).filter((name) => known.has(name))) {
        admin
          .prepare(
            table === 'event_sources'
              ? "DELETE FROM event_sources WHERE key <> 'sqlite:single-node'"
              : `DELETE FROM ${table}`,
          )
          .run();
      }

      return Promise.resolve();
    },
    stop: async () => {
      await persistence.close();
      admin.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function startTestDatabase(name: string): Promise<TestDatabase> {
  switch (ADAPTER) {
    case 'mongo':
      return startMongo(name);
    case 'postgres':
      return startPostgres();
    case 'sqlite':
      return startSqlite();
    default:
      return assertNever(ADAPTER);
  }
}
