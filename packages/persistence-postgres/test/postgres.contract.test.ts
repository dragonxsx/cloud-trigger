import { type TestPersistence, describePersistenceContract } from '@cloud-trigger/testing';
import { afterAll, beforeAll } from 'vitest';

import type { PostgresPersistence } from '../src/index.js';
import { startTestPostgres } from '../src/testing.js';

const END_OF_TIME = new Date(8_640_000_000_000_000);

let db: TestPersistence<PostgresPersistence>;

beforeAll(async () => {
  db = await startTestPostgres();
}, 180_000);

afterAll(() => db.stop());

describePersistenceContract('postgres', {
  ports: () => db.persistence,
  reset: async () => {
    await db.persistence.sweep(END_OF_TIME);
    await db.clear();
  },
});
