import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SQL_TABLES } from '@cloud-trigger/persistence-sql';
import type { TestPersistence } from '@cloud-trigger/testing';
import Database from 'better-sqlite3';

import { SQLITE_GUARD_KEY, type SqlitePersistence, createSqlitePersistence } from './index.js';

export interface TestSqlite extends TestPersistence<SqlitePersistence> {
  readonly path: string;
}

export async function startTestSqlite(): Promise<TestSqlite> {
  const dir = mkdtempSync(join(tmpdir(), 'ct-sqlite-'));
  const path = join(dir, 'test.db');
  const persistence = createSqlitePersistence({ path });
  await persistence.migrate();
  const admin = new Database(path);
  admin.pragma('busy_timeout = 5000');
  const known = new Set<string>(SQL_TABLES);

  return {
    persistence,
    path,
    clear: (tables) => {
      for (const table of (tables ?? SQL_TABLES).filter((name) => known.has(name))) {
        if (table === 'event_sources') {
          admin.prepare('DELETE FROM event_sources WHERE key <> ?').run(SQLITE_GUARD_KEY);
        } else {
          admin.prepare(`DELETE FROM ${table}`).run();
        }
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
