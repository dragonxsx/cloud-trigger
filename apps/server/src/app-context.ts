import { type Logger, ProviderRegistry, type Run, systemClock } from '@cloud-trigger/core';
import { AnalyticsListener, JobService, Reaper, Scheduler, Worker } from '@cloud-trigger/engine';
import { type MongoPersistence, createMongoPersistence } from '@cloud-trigger/persistence-mongo';
import { builtinProviders } from '@cloud-trigger/providers-builtin';
import { EventPublisher } from '@orpc/server';
import type { Logger as Pino } from 'pino';

import { Authenticator } from './auth/authenticator.js';
import type { AppConfig } from './config.js';
import { EngineRuntime } from './engine/engine-runtime.js';
import { pinoLogger } from './infra/logger.js';
import { AppMetrics } from './infra/metrics.js';
import { loadPlugins } from './infra/plugins.js';
import { envAndFileSecretResolver } from './infra/secrets.js';

export interface AppContext {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly pino: Pino;
  readonly persistence: MongoPersistence;
  readonly registry: ProviderRegistry;
  readonly jobService: JobService;
  readonly authenticator: Authenticator;
  readonly metrics: AppMetrics;
  readonly runEvents: EventPublisher<{ run: Run }>;
  readonly engine: EngineRuntime;
}

export async function createAppContext(config: AppConfig, pino: Pino): Promise<AppContext> {
  const logger = pinoLogger(pino);
  const registry = new ProviderRegistry().use(builtinProviders);
  const plugins = await loadPlugins(registry, config.PLUGINS);
  if (plugins.length > 0) {
    logger.info('Loaded provider plugins', { plugins });
  }

  const persistence = await createMongoPersistence({
    uri: config.MONGO_URI,
    dbName: config.MONGO_DB,
    analyticsUri: config.ANALYTICS_MONGO_URI,
    analyticsDbName: config.ANALYTICS_MONGO_DB,
    runRetentionDays: config.RUN_RETENTION_DAYS,
    metricsRetentionDays: config.METRICS_RETENTION_DAYS,
    onEventBusError: (error) => logger.warn('Change stream error; reconnecting', { err: error }),
  });
  await persistence.migrate();

  const clock = systemClock;
  const metrics = new AppMetrics();
  const secrets = envAndFileSecretResolver({
    prefix: config.SECRET_ENV_PREFIX,
    dir: config.SECRETS_DIR,
  });
  const roles = new Set(config.APP_ROLE);
  const id = config.INSTANCE_ID;

  const scheduler = roles.has('scheduler')
    ? new Scheduler(
        { ...persistence, registry, clock, logger },
        {
          ownerId: id,
          intervalMs: config.SCHEDULER_INTERVAL_MS,
          claimLeaseMs: 30_000,
          batchSize: config.SCHEDULER_BATCH_SIZE,
        },
      )
    : undefined;
  const listeners = [new AnalyticsListener(persistence.analytics), metrics];
  const reaper = roles.has('scheduler')
    ? new Reaper(
        { ...persistence, clock, logger, listeners },
        { intervalMs: config.REAPER_INTERVAL_MS, batchSize: 100 },
      )
    : undefined;
  const worker = roles.has('worker')
    ? new Worker(
        {
          ...persistence,
          registry,
          secrets,
          clock,
          logger,
          listeners,
        },
        {
          workerId: id,
          concurrency: config.WORKER_CONCURRENCY,
          pollIntervalMs: config.WORKER_POLL_MS,
          leaseMs: config.LEASE_MS,
          bufferedRequeueDelayMs: 1_000,
        },
      )
    : undefined;
  if (worker) {
    metrics.observeActiveRuns(() => worker.activeRuns);
  }

  const runEvents = new EventPublisher<{ run: Run }>();
  if (roles.has('api')) {
    persistence.events.subscribe((event) => {
      if (event.type === 'run.changed') {
        runEvents.publish('run', event.run);
      }
    });
    persistence.events.start();
  }

  return {
    config,
    logger,
    pino,
    persistence,
    registry,
    jobService: new JobService({ ...persistence, registry, clock, logger, listeners }),
    authenticator: new Authenticator(config),
    metrics,
    runEvents,
    engine: new EngineRuntime(
      { ...(scheduler && { scheduler }), ...(reaper && { reaper }), ...(worker && { worker }) },
      logger,
    ),
  };
}
