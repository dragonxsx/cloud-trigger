import {
  type Logger,
  type Persistence,
  ProviderRegistry,
  type Run,
  type Tracer,
  systemClock,
} from '@cloud-trigger/core';
import {
  AnalyticsListener,
  ChainListener,
  ConsumerSupervisor,
  EventIngestor,
  GroupService,
  JobTransfer,
  JobService,
  NotificationDispatcher,
  NotificationEnqueuer,
  NotificationListener,
  Reaper,
  Scheduler,
  SlaMonitor,
  Worker,
  WorkflowAdvancer,
  WorkflowMonitor,
  WorkflowRuntime,
  WorkflowService,
} from '@cloud-trigger/engine';
import { awsProviders } from '@cloud-trigger/providers-aws';
import { builtinProviders, createFanoutTarget } from '@cloud-trigger/providers-builtin';
import { grpcProviders } from '@cloud-trigger/providers-grpc';
import { kafkaProviders } from '@cloud-trigger/providers-kafka';
import { natsProviders } from '@cloud-trigger/providers-nats';
import { EventPublisher } from '@orpc/server';
import type { Logger as Pino } from 'pino';

import { Authenticator } from './auth/authenticator.js';
import type { AppConfig } from './config.js';
import { type BackgroundLoop, EngineRuntime } from './engine/engine-runtime.js';
import { pinoLogger } from './infra/logger.js';
import { AppMetrics } from './infra/metrics.js';
import { createPersistence } from './infra/persistence.js';
import { loadPlugins } from './infra/plugins.js';
import { envAndFileSecretResolver } from './infra/secrets.js';
import { startTracing } from './infra/tracing.js';

export interface AppContext {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly pino: Pino;
  readonly persistence: Persistence;
  readonly registry: ProviderRegistry;
  readonly jobService: JobService;
  readonly ingestor: EventIngestor;
  readonly workflowService: WorkflowService;
  readonly groupService: GroupService;
  readonly jobTransfer: JobTransfer;
  readonly authenticator: Authenticator;
  readonly metrics: AppMetrics;
  readonly runEvents: EventPublisher<{ run: Run }>;
  readonly engine: EngineRuntime;
  readonly shutdownTracing: () => Promise<void>;
}

export interface AppContextOptions {
  readonly tracer?: Tracer | undefined;
}

export async function createAppContext(
  config: AppConfig,
  pino: Pino,
  options: AppContextOptions = {},
): Promise<AppContext> {
  const logger = pinoLogger(pino);
  const tracing = options.tracer ? undefined : startTracing(config);
  const tracer = options.tracer ?? tracing?.tracer;
  const registry = new ProviderRegistry().use(
    builtinProviders,
    grpcProviders,
    awsProviders,
    kafkaProviders,
    natsProviders,
  );
  const plugins = await loadPlugins(registry, config.PLUGINS);
  if (plugins.length > 0) {
    logger.info('Loaded provider plugins', { plugins });
  }
  registry.register(createFanoutTarget(registry));

  const persistence = await createPersistence(config, logger);
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
  const enqueuer = new NotificationEnqueuer({
    outbox: persistence.outbox,
    groups: persistence.groups,
    clock,
  });
  const workflowRuntime = new WorkflowRuntime({ ...persistence, clock, logger });
  const listeners = [
    new AnalyticsListener(persistence.analytics),
    metrics,
    new NotificationListener(enqueuer),
    new ChainListener({ ...persistence, registry, clock, logger }),
    new WorkflowAdvancer(workflowRuntime),
  ];
  const reaper = roles.has('scheduler')
    ? new Reaper(
        { ...persistence, clock, logger, listeners },
        { intervalMs: config.REAPER_INTERVAL_MS, batchSize: 100, slotIdleMs: config.LEASE_MS * 2 },
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
          tracer,
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
  const dispatcher = roles.has('worker')
    ? new NotificationDispatcher(
        { ...persistence, registry, secrets, clock, logger },
        {
          workerId: id,
          pollIntervalMs: config.NOTIFY_POLL_MS,
          timeoutMs: config.NOTIFY_TIMEOUT_MS,
          leaseMs: config.NOTIFY_TIMEOUT_MS * 3,
          retry: {
            maxAttempts: config.NOTIFY_MAX_ATTEMPTS,
            backoff: 'exponential',
            delayMs: 5_000,
            maxDelayMs: 600_000,
          },
        },
      )
    : undefined;
  const slaMonitor = roles.has('scheduler')
    ? new SlaMonitor(
        { ...persistence, enqueuer, clock, logger, listeners },
        { intervalMs: config.SLA_INTERVAL_MS, batchSize: 100 },
      )
    : undefined;
  const ingestor = new EventIngestor({
    ...persistence,
    registry,
    secrets,
    clock,
    logger,
    defaultWebhookPerSecond: config.WEBHOOK_MAX_PER_SECOND,
  });
  const consumers = roles.has('consumer')
    ? new ConsumerSupervisor(
        { ...persistence, registry, secrets, clock, logger, ingestor },
        {
          ownerId: id,
          intervalMs: config.CONSUMER_INTERVAL_MS,
          leaseMs: config.CONSUMER_LEASE_MS,
          restartDelayMs: 1_000,
        },
      )
    : undefined;
  const workflowMonitor = roles.has('scheduler')
    ? new WorkflowMonitor(
        { ...persistence, registry, clock, logger, runtime: workflowRuntime },
        { intervalMs: config.SCHEDULER_INTERVAL_MS, batchSize: config.SCHEDULER_BATCH_SIZE },
      )
    : undefined;
  const loops: BackgroundLoop[] = [
    scheduler,
    reaper,
    slaMonitor,
    dispatcher,
    consumers,
    workflowMonitor,
  ].filter((l) => l !== undefined);

  const runEvents = new EventPublisher<{ run: Run }>();
  if (roles.has('api')) {
    persistence.events.subscribe((event) => {
      if (event.type === 'run.changed') {
        runEvents.publish('run', event.run);
      }
    });
    persistence.events.start();
  }

  const jobService = new JobService({ ...persistence, registry, clock, logger, listeners });
  const workflowService = new WorkflowService({
    ...persistence,
    registry,
    clock,
    jobService,
    runtime: workflowRuntime,
  });

  return {
    config,
    logger,
    pino,
    persistence,
    registry,
    jobService,
    ingestor,
    workflowService,
    jobTransfer: new JobTransfer({ ...persistence, registry, service: jobService }),
    groupService: new GroupService({ ...persistence, registry, clock }),
    authenticator: new Authenticator(config),
    metrics,
    runEvents,
    engine: new EngineRuntime({ loops, worker }, logger),
    shutdownTracing: tracing?.shutdown ?? (() => Promise.resolve()),
  };
}
