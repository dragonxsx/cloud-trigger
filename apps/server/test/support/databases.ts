import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { inject } from 'vitest';

export type TestEnv = Readonly<Record<string, string>>;

const run = randomUUID().slice(0, 8);

export const mongoEnv = (db: string): TestEnv => ({
  MONGO_URI: inject('mongoUri'),
  MONGO_DB: `${db}_${run}`,
});

export interface TestPostgres {
  readonly env: TestEnv;
  readonly stop: () => Promise<void>;
}

export async function startPostgres(): Promise<TestPostgres> {
  const container = await new PostgreSqlContainer(
    process.env['POSTGRES_IMAGE'] ?? 'postgres:18-alpine',
  ).start();

  return {
    env: { DB_DRIVER: 'postgres', POSTGRES_URL: container.getConnectionUri() },
    stop: async () => {
      await container.stop();
    },
  };
}

export interface TempSqlite {
  readonly env: TestEnv;
  readonly path: (name: string) => string;
  readonly cleanup: () => void;
}

export function tempSqlite(prefix: string): TempSqlite {
  const dir = mkdtempSync(join(tmpdir(), `ct-${prefix}-`));
  const path = (name: string) => join(dir, name);

  return {
    env: { DB_DRIVER: 'sqlite', SQLITE_PATH: path('app.db') },
    path,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
