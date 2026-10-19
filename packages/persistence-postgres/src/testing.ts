import { SQL_TABLES } from '@cloud-trigger/persistence-sql';
import type { TestPersistence } from '@cloud-trigger/testing';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';

import { type PostgresPersistence, createPostgresPersistence } from './index.js';

export async function startTestPostgres(
  options: { readonly maxConnections?: number | undefined } = {},
): Promise<TestPersistence<PostgresPersistence>> {
  const container = await new PostgreSqlContainer(
    process.env['POSTGRES_IMAGE'] ?? 'postgres:18-alpine',
  ).start();
  const url = container.getConnectionUri();
  const persistence = createPostgresPersistence({ url, maxConnections: options.maxConnections });
  await persistence.migrate();
  const admin = postgres(url, { max: 1, onnotice: () => undefined });
  const known = new Set<string>(SQL_TABLES);

  return {
    persistence,
    clear: async (tables) => {
      const names = (tables ?? SQL_TABLES).filter((table) => known.has(table));
      if (names.length > 0) {
        await admin.unsafe(`TRUNCATE ${names.join(', ')}`);
      }
    },
    stop: async () => {
      await persistence.close();
      await admin.end();
      await container.stop();
    },
  };
}
