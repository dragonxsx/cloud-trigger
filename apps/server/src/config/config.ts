import { hostname } from 'node:os';

import {
  type ConfigIssue,
  DEFAULT_RETENTION,
  type Result,
  assertNever,
  err,
  ok,
} from '@cloud-trigger/core';
import { z } from 'zod';

const splitCsv = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
const csv = z.string().default('').transform(splitCsv);

const KEY_HINT = 'Use 32 random bytes, base64-encoded (openssl rand -base64 32)';
const EncryptionKey = z
  .base64({ error: KEY_HINT })
  .transform((s) => Buffer.from(s, 'base64'))
  .refine((key) => key.length === 32, KEY_HINT);

const Role = z.enum(['api', 'scheduler', 'worker', 'consumer']);
export type Role = z.output<typeof Role>;

const ConfigShape = z.object({
  APP_ROLE: z
    .string()
    .default('all')
    .transform((s) => splitCsv(s === 'all' ? 'api,scheduler,worker,consumer' : s))
    .pipe(z.array(Role).min(1)),
  PORT: z.coerce.number().int().default(8080),
  INSTANCE_ID: z.string().default(`${hostname()}-${process.pid}`),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  DB_DRIVER: z
    .enum(['mongo', 'postgres', 'sqlite'])
    .optional()
    .describe(
      'Storage adapter, inferred from MONGO_URI or POSTGRES_URL when unset. sqlite is for single-node installs (APP_ROLE=all, 1 replica). Without one, the server starts the setup wizard.',
    ),
  MONGO_URI: z.string().min(1).optional(),
  POSTGRES_URL: z.string().min(1).optional(),
  POSTGRES_MAX_CONNECTIONS: z.coerce.number().int().positive().default(10),
  SQLITE_PATH: z.string().min(1).default('./data/cloud-trigger.db'),
  MONGO_DB: z.string().default('cloud_trigger'),
  ANALYTICS_MONGO_URI: z.string().optional(),
  ANALYTICS_MONGO_DB: z.string().optional(),
  RUN_RETENTION_DAYS: z.coerce.number().int().positive().default(DEFAULT_RETENTION.runDays),
  METRICS_RETENTION_DAYS: z.coerce.number().int().positive().default(DEFAULT_RETENTION.metricsDays),
  DECISION_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_RETENTION.decisionDays),

  SCHEDULER_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
  SCHEDULER_BATCH_SIZE: z.coerce.number().int().positive().default(100),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(16),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(500),
  LEASE_MS: z.coerce.number().int().min(1_000).default(30_000),
  REAPER_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  SLA_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  NOTIFY_POLL_MS: z.coerce.number().int().positive().default(1_000),
  NOTIFY_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),
  NOTIFY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(5),
  CONSUMER_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5_000)
    .describe('How often consumers re-check event-source jobs and renew their leases.'),
  CONSUMER_LEASE_MS: z.coerce.number().int().min(1_000).default(30_000),
  WEBHOOK_MAX_PER_SECOND: z.coerce
    .number()
    .positive()
    .default(20)
    .describe('Default per-job rate limit for inbound webhooks without their own limit.'),
  WEBHOOK_MAX_BODY_BYTES: z.coerce.number().int().positive().max(262_144).default(262_144),

  SETUP_TOKEN: z
    .string()
    .min(16)
    .optional()
    .describe('Presets the first-run setup token; set it when several replicas serve the API.'),
  CORS_ORIGINS: csv,
  BADGES_PUBLIC: z.stringbool().default(false),
  OPENAPI_FETCH_ALLOW_PRIVATE: z
    .stringbool()
    .default(false)
    .describe('Lets OpenAPI imports fetch specs from private, loopback and link-local addresses.'),
  CALENDAR_TOKEN_SECRET: z
    .string()
    .min(32, 'Use at least 32 characters')
    .optional()
    .describe('Signs calendar subscription tokens; rotate it to revoke every token.'),
  PUBLIC_URL: z.url().optional().describe('Base URL used in calendar links and subscribe URLs.'),

  DATA_ENCRYPTION_KEY: EncryptionKey.describe(
    'Encrypts secret provider fields and the session secret at rest; back it up.',
  ),
  DATA_ENCRYPTION_PREVIOUS_KEYS: csv
    .pipe(z.array(EncryptionKey))
    .describe('Retired keys that still decrypt stored values until `reseal-secrets` has run.'),
  SECRETS_DIR: z.string().optional(),
  SECRET_ENV_PREFIX: z.string().default('CT_SECRET_'),
  WEB_DIST: z.string().optional(),
  PLUGINS: csv,
  OTEL_EXPORTER_OTLP_ENDPOINT: z
    .url()
    .optional()
    .describe('Enables OpenTelemetry tracing; the SDK also reads the other OTEL_* variables.'),
  OTEL_SERVICE_NAME: z.string().default('cloud-trigger'),
});
const ALL_ROLES: readonly Role[] = ['api', 'scheduler', 'worker', 'consumer'];

export const AppConfig = ConfigShape.superRefine((config, ctx) => {
  if (config.DB_DRIVER === 'sqlite' && !ALL_ROLES.every((role) => config.APP_ROLE.includes(role))) {
    ctx.addIssue({
      code: 'custom',
      path: ['APP_ROLE'],
      message: 'DB_DRIVER=sqlite runs every role in one process; use APP_ROLE=all',
    });
  }
});
export type AppConfig = z.output<typeof AppConfig>;

export type DatabaseConfig =
  | {
      readonly driver: 'mongo';
      readonly uri: string;
      readonly dbName: string;
      readonly analyticsUri: string | undefined;
      readonly analyticsDbName: string | undefined;
    }
  | { readonly driver: 'postgres'; readonly url: string; readonly maxConnections: number }
  | { readonly driver: 'sqlite'; readonly path: string };

export type DatabaseDriver = DatabaseConfig['driver'];

export const inferDriver = (config: AppConfig): DatabaseDriver | undefined =>
  config.DB_DRIVER ??
  (config.MONGO_URI !== undefined
    ? 'mongo'
    : config.POSTGRES_URL !== undefined
      ? 'postgres'
      : undefined);

const missing = (path: string, driver: string): ConfigIssue => ({
  path,
  message: `Required when DB_DRIVER=${driver}`,
});

export function databaseConfig(config: AppConfig): Result<DatabaseConfig, ConfigIssue[]> {
  const driver = inferDriver(config);
  switch (driver) {
    case undefined:
      return err([{ path: 'DB_DRIVER', message: 'No database is configured' }]);
    case 'mongo':
      return config.MONGO_URI === undefined
        ? err([missing('MONGO_URI', driver)])
        : ok({
            driver,
            uri: config.MONGO_URI,
            dbName: config.MONGO_DB,
            analyticsUri: config.ANALYTICS_MONGO_URI,
            analyticsDbName: config.ANALYTICS_MONGO_DB,
          });
    case 'postgres':
      return config.POSTGRES_URL === undefined
        ? err([missing('POSTGRES_URL', driver)])
        : ok({ driver, url: config.POSTGRES_URL, maxConnections: config.POSTGRES_MAX_CONNECTIONS });
    case 'sqlite':
      return ok({ driver, path: config.SQLITE_PATH });
    default:
      return assertNever(driver);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = AppConfig.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }

  return parsed.data;
}
