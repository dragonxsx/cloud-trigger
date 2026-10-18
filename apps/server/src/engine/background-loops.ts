import type {
  Clock,
  Logger,
  Persistence,
  ProviderRegistry,
  SecretResolver,
  Tracer,
} from '@cloud-trigger/core';
import {
  ConsumerSupervisor,
  type EventIngestor,
  type NotificationEnqueuer,
  NotificationDispatcher,
  Reaper,
  type RunLifecycleListener,
  Scheduler,
  SlaMonitor,
  Worker,
  WorkflowMonitor,
  type WorkflowRuntime,
} from '@cloud-trigger/engine';

import type { AppConfig } from '../config/config.js';
import type { AppMetrics } from '../infra/telemetry/metrics.js';
import type { BackgroundLoop, EngineParts } from './engine-runtime.js';

export interface BackgroundLoopDeps {
  readonly config: AppConfig;
  readonly persistence: Persistence;
  readonly registry: ProviderRegistry;
  readonly secrets: SecretResolver;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly tracer: Tracer | undefined;
  readonly metrics: AppMetrics;
  readonly listeners: readonly RunLifecycleListener[];
  readonly enqueuer: NotificationEnqueuer;
  readonly workflowRuntime: WorkflowRuntime;
  readonly ingestor: EventIngestor;
}

export function createBackgroundLoops(deps: BackgroundLoopDeps): EngineParts {
  const { config, persistence, registry, secrets, clock, logger, tracer, listeners } = deps;
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
  const reaper = roles.has('scheduler')
    ? new Reaper(
        { ...persistence, clock, logger, listeners },
        { intervalMs: config.REAPER_INTERVAL_MS, batchSize: 100, slotIdleMs: config.LEASE_MS * 2 },
      )
    : undefined;
  const worker = roles.has('worker')
    ? new Worker(
        { ...persistence, registry, secrets, clock, logger, listeners, tracer },
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
    deps.metrics.observeActiveRuns(() => worker.activeRuns);
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
        { ...persistence, enqueuer: deps.enqueuer, clock, logger, listeners },
        { intervalMs: config.SLA_INTERVAL_MS, batchSize: 100 },
      )
    : undefined;
  const consumers = roles.has('consumer')
    ? new ConsumerSupervisor(
        { ...persistence, registry, secrets, clock, logger, ingestor: deps.ingestor },
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
        { ...persistence, registry, clock, logger, runtime: deps.workflowRuntime },
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

  return { loops, worker };
}
