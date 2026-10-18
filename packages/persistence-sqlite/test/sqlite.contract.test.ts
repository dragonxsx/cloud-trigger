import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describePersistenceContract } from '@cloud-trigger/testing';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type SqlitePersistence, createSqlitePersistence } from '../src/index.js';

const TABLES = [
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
];

const dir = mkdtempSync(join(tmpdir(), 'ct-sqlite-'));
const path = join(dir, 'contract.db');
let persistence: SqlitePersistence;

beforeAll(async () => {
  persistence = createSqlitePersistence({ path });
  await persistence.migrate();
});

afterAll(async () => {
  await persistence.close();
  rmSync(dir, { recursive: true, force: true });
});

describePersistenceContract('sqlite', {
  ports: () => persistence,
  reset: async () => {
    const admin = new Database(path);
    for (const table of TABLES) {
      admin
        .prepare(
          `DELETE FROM ${table} WHERE NOT (${table === 'event_sources' ? "key = 'sqlite:single-node'" : '0'})`,
        )
        .run();
    }
    admin.close();
    await Promise.resolve();
  },
});

describe('sqlite single-node guard', () => {
  it('refuses a second process on the same database', async () => {
    const second = createSqlitePersistence({ path });
    await expect(second.migrate()).rejects.toThrow(/single node/);
    await second.close();
  });
});
