import {
  at,
  describePersistenceContract,
  makeWorkflow,
  makeWorkflowRun,
} from '@cloud-trigger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
