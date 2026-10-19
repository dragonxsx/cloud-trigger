import { describePersistenceContract } from '@cloud-trigger/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll } from 'vitest';

import { type PostgresPersistence, createPostgresPersistence } from '../src/index.js';

const TABLES = [
  'jobs',
  'job_tags',
  'job_upstreams',
  'runs',
  'fire_keys',
  'groups',
  'rate_limits',
  'notifications_outbox',
  'schedule_decisions',
  'run_metrics',
  'event_sources',
  'workflows',
  'workflow_runs',
  'auth_settings',
  'users',
  'api_keys',
];

let container: StartedPostgreSqlContainer;
let persistence: PostgresPersistence;
let reset: () => Promise<void>;

beforeAll(async () => {
  container = await new PostgreSqlContainer(
    process.env['POSTGRES_IMAGE'] ?? 'postgres:18-alpine',
  ).start();
  persistence = createPostgresPersistence({ url: container.getConnectionUri() });
  await persistence.migrate();
  const admin = createPostgresPersistence({ url: container.getConnectionUri(), maxConnections: 1 });
  reset = async () => {
    await admin.sweep(new Date(8_640_000_000_000_000));
    await truncate(container.getConnectionUri());
  };
}, 180_000);

afterAll(async () => {
  await persistence.close();
  await container.stop();
});

async function truncate(url: string) {
  const { default: postgres } = await import('postgres');
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  await sql.unsafe(`TRUNCATE ${TABLES.join(', ')}`);
  await sql.end();
}

describePersistenceContract('postgres', {
  ports: () => persistence,
  reset: () => reset(),
});
