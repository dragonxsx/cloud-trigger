import { describePersistenceContract } from '@cloud-trigger/testing';
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
