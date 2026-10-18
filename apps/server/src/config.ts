import { hostname } from 'node:os';

import { Scope } from '@cloud-trigger/api-contract';
import { z } from 'zod';

const splitCsv = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
const csv = z.string().default('').transform(splitCsv);

const Role = z.enum(['api', 'scheduler', 'worker']);
export type Role = z.output<typeof Role>;

const ApiKeys = csv.pipe(
  z.array(
    z
      .string()
      .transform((entry) => entry.split(':'))
      .pipe(
        z.tuple([z.string().min(1), z.string().regex(/^[0-9a-f]{64}$/, 'sha256 hex'), z.string()]),
      )
      .transform(([name, hash, scopes]) => ({ name, hash, scopes: scopes.split('|') }))
      .pipe(z.object({ name: z.string(), hash: z.string(), scopes: z.array(Scope) })),
  ),
);

export const AppConfig = z.object({
  APP_ROLE: z
    .string()
    .default('all')
    .transform((s) => splitCsv(s === 'all' ? 'api,scheduler,worker' : s))
    .pipe(z.array(Role).min(1)),
  PORT: z.coerce.number().int().default(8080),
  INSTANCE_ID: z.string().default(`${hostname()}-${process.pid}`),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  MONGO_URI: z.string().min(1),
  MONGO_DB: z.string().default('cloud_trigger'),
  ANALYTICS_MONGO_URI: z.string().optional(),
  ANALYTICS_MONGO_DB: z.string().optional(),
  RUN_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  METRICS_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  DECISION_RETENTION_DAYS: z.coerce.number().int().positive().default(14),

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

  AUTH_DISABLED: z.stringbool().default(false),
  OIDC_ISSUER: z.url().optional(),
  OIDC_AUDIENCE: z.string().optional(),
  OIDC_JWKS_URI: z.url().optional(),
  OIDC_SCOPE_PREFIX: z.string().default('cloud-trigger:'),
  OIDC_CLIENT_ID: z.string().optional().describe('Public client the web UI signs in with (PKCE).'),
  OIDC_UI_SCOPE: z
    .string()
    .default('openid profile cloud-trigger:read cloud-trigger:write')
    .describe('Scopes the web UI requests.'),
  OIDC_DEFAULT_SCOPES: csv.pipe(z.array(Scope)).default(['read']),
  API_KEYS: ApiKeys,
  ANONYMOUS_SCOPES: csv.pipe(z.array(Scope)),
  CORS_ORIGINS: csv,
  BADGES_PUBLIC: z.stringbool().default(false),
  CALENDAR_TOKEN_SECRET: z
    .string()
    .min(32, 'Use at least 32 characters')
    .optional()
    .describe('Signs calendar subscription tokens; rotate it to revoke every token.'),
  PUBLIC_URL: z.url().optional().describe('Base URL used in calendar links and subscribe URLs.'),

  SECRETS_DIR: z.string().optional(),
  SECRET_ENV_PREFIX: z.string().default('CT_SECRET_'),
  WEB_DIST: z.string().optional(),
  PLUGINS: csv,
});
export type AppConfig = z.output<typeof AppConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = AppConfig.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }

  return parsed.data;
}
