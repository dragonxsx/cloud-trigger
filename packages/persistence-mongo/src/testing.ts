import type { TestPersistence } from '@cloud-trigger/testing';
import { MongoDBContainer } from '@testcontainers/mongodb';
import { MongoClient } from 'mongodb';

import { createMongoPersistence } from './index.js';

export async function startTestMongo(
  options: { readonly dbName?: string | undefined } = {},
): Promise<TestPersistence> {
  const dbName = options.dbName ?? 'test';
  const container = await new MongoDBContainer(process.env['MONGO_IMAGE'] ?? 'mongo:8').start();
  const uri = `${container.getConnectionString()}?directConnection=true`;
  const persistence = await createMongoPersistence({ uri, dbName });
  await persistence.migrate();
  const admin = await MongoClient.connect(uri);

  return {
    persistence,
    clear: async (tables) => {
      const collections = await admin.db(dbName).collections();
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
