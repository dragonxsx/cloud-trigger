import {
  at,
  describePersistenceContract,
  makeWorkflow,
  makeWorkflowRun,
} from '@cloud-trigger/testing';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createSqlitePersistence } from '../src/index.js';
import { type TestSqlite, startTestSqlite } from '../src/testing.js';

let db: TestSqlite;

beforeAll(async () => {
  db = await startTestSqlite();
});

afterAll(() => db.stop());

describePersistenceContract('sqlite', {
  ports: () => db.persistence,
  reset: () => db.clear(),
});

describe('sqlite single-node guard', () => {
  it('refuses a second process on the same database', async () => {
    const second = createSqlitePersistence({ path: db.path });
    await expect(second.migrate()).rejects.toThrow(/single node/);
    await second.close();
  });
});

describe('sqlite retention sweep', () => {
  it('deletes finished workflow runs past run retention and keeps running ones', async () => {
    await db.clear();
    const { workflowRuns } = db.persistence;
    const workflow = makeWorkflow();
    const running = makeWorkflowRun(workflow);
    const old = { ...makeWorkflowRun(workflow), status: 'succeeded' as const, finishedAt: at(0) };
    const recent = {
      ...makeWorkflowRun(workflow),
      status: 'failed' as const,
      finishedAt: at(29 * 86_400_000),
    };
    for (const run of [running, old, recent]) {
      await workflowRuns.insert(run);
    }
    await db.persistence.sweep(at(31 * 86_400_000));
    expect(await workflowRuns.get(old.id)).toBeUndefined();
    expect(await workflowRuns.get(recent.id)).toEqual(recent);
    expect(await workflowRuns.get(running.id)).toEqual(running);
  });
});

describe('sqlite legacy workflow run backfill', () => {
  const FinishedAt = z.object({ finished_at: z.number().nullable() });

  it('backfills finished_at once, then stops scanning after the backlog drains', async () => {
    const legacyDb = await startTestSqlite();
    const raw = new Database(legacyDb.path);
    const finishedAtOf = (id: string) =>
      FinishedAt.parse(raw.prepare('SELECT finished_at FROM workflow_runs WHERE id = ?').get(id))
        .finished_at;
    const insertLegacy = async () => {
      const run = {
        ...makeWorkflowRun(makeWorkflow()),
        status: 'succeeded' as const,
        finishedAt: at(0),
      };
      await legacyDb.persistence.workflowRuns.insert(run);
      raw.prepare('UPDATE workflow_runs SET finished_at = NULL WHERE id = ?').run(run.id);

      return run;
    };
    try {
      const legacy = await insertLegacy();
      await legacyDb.persistence.sweep(at(0));
      expect(finishedAtOf(legacy.id)).toBe(at(0).getTime());

      const late = await insertLegacy();
      await legacyDb.persistence.sweep(at(0));
      expect(finishedAtOf(late.id)).toBeNull();
    } finally {
      raw.close();
      await legacyDb.stop();
    }
  });
});
