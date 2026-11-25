import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createMongoPersistence } from '../src/index.js';

const DAY_SECONDS = 86_400;
const dbName = 'retention';
const IndexInfo = z.object({ name: z.string(), expireAfterSeconds: z.number().optional() });
const CollectionInfo = z.object({
  options: z.object({ expireAfterSeconds: z.number().optional() }),
});

let container: StartedMongoDBContainer;
let uri: string;
let admin: MongoClient;

beforeAll(async () => {
  container = await new MongoDBContainer(process.env['MONGO_IMAGE'] ?? 'mongo:8').start();
  uri = `${container.getConnectionString()}?directConnection=true`;
  admin = await MongoClient.connect(uri);
}, 120_000);

afterAll(async () => {
  await admin.close();
  await container.stop();
});

async function migrateWith(days: number): Promise<void> {
  const persistence = await createMongoPersistence({
    uri,
    dbName,
    retention: { runDays: days, metricsDays: days, decisionDays: days },
  });
  await persistence.migrate();
  await persistence.close();
}

async function retentionTtl(collection: string): Promise<number | undefined> {
  const indexes = z.array(IndexInfo).parse(await admin.db(dbName).collection(collection).indexes());

  return indexes.find((index) => index.name === 'retention')?.expireAfterSeconds;
}

async function collectionTtl(collection: string): Promise<number | undefined> {
  const info = await admin.db(dbName).listCollections({ name: collection }).next();

  return CollectionInfo.parse(info).options.expireAfterSeconds;
}

describe('mongo retention', () => {
  it('applies a changed retention to existing TTL indexes on the next migrate', async () => {
    await migrateWith(30);
    await migrateWith(7);

    for (const collection of ['runs', 'workflow_runs', 'schedule_decisions']) {
      expect(await retentionTtl(collection)).toBe(7 * DAY_SECONDS);
    }
    expect(await collectionTtl('run_metrics')).toBe(7 * DAY_SECONDS);
  }, 60_000);
});
