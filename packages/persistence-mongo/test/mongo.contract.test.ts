import { describePersistenceContract } from '@cloud-trigger/testing';
import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll } from 'vitest';

import { type MongoPersistence, createMongoPersistence } from '../src/index.js';

const DB = 'contract';
let container: StartedMongoDBContainer;
let persistence: MongoPersistence;
let admin: MongoClient;

beforeAll(async () => {
  container = await new MongoDBContainer('mongo:8').start();
  const uri = `${container.getConnectionString()}?directConnection=true`;
  persistence = await createMongoPersistence({ uri, dbName: DB });
  await persistence.migrate();
  admin = await MongoClient.connect(uri);
}, 120_000);

afterAll(async () => {
  await persistence.close();
  await admin.close();
  await container.stop();
});

describePersistenceContract('mongo', {
  ports: () => persistence,
  reset: async () => {
    const db = admin.db(DB);
    const collections = await db.collections();
    await Promise.all(
      collections
        .filter((c) => !c.collectionName.startsWith('system.'))
        .map((c) => c.deleteMany({})),
    );
  },
});
