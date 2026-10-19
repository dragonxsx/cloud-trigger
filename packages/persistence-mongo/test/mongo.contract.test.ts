import { type TestPersistence, describePersistenceContract } from '@cloud-trigger/testing';
import { afterAll, beforeAll } from 'vitest';

import { startTestMongo } from '../src/testing.js';

let db: TestPersistence;

beforeAll(async () => {
  db = await startTestMongo({ dbName: 'contract' });
}, 120_000);

afterAll(() => db.stop());

describePersistenceContract('mongo', {
  ports: () => db.persistence,
  reset: () => db.clear(),
});
