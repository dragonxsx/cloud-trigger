import { assertNever } from '@cloud-trigger/core';
import { startTestMongo } from '@cloud-trigger/persistence-mongo/testing';
import { startTestPostgres } from '@cloud-trigger/persistence-postgres/testing';
import { startTestSqlite } from '@cloud-trigger/persistence-sqlite/testing';
import type { TestPersistence } from '@cloud-trigger/testing';
import { z } from 'zod';

export const Adapter = z.enum(['mongo', 'postgres', 'sqlite']);
export type Adapter = z.output<typeof Adapter>;

export const ADAPTER: Adapter = Adapter.default('mongo').parse(process.env['ENGINE_DB']);

export type TestDatabase = TestPersistence;

export function startTestDatabase(name: string): Promise<TestDatabase> {
  switch (ADAPTER) {
    case 'mongo':
      return startTestMongo({ dbName: name });
    case 'postgres':
      return startTestPostgres({ maxConnections: 20 });
    case 'sqlite':
      return startTestSqlite();
    default:
      return assertNever(ADAPTER);
  }
}
