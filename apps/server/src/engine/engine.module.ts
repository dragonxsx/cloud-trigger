import { ProviderRegistry } from '@cloud-trigger/core';
import {
  AnalyticsListener,
  ChainListener,
  ConnectionExtractor,
  ConnectionService,
  EnvironmentService,
  EventIngestor,
  GroupService,
  JobService,
  JobTransfer,
  NotificationEnqueuer,
  NotificationListener,
  type RunLifecycleListener,
  WorkflowAdvancer,
  WorkflowRuntime,
  WorkflowService,
} from '@cloud-trigger/engine';
import { Module } from '@nestjs/common';

import { factoryProvider, injectionToken, token } from '../common/tokens.js';
import { ConfigService } from '../config/config.module.js';
import { LOGGER } from '../infra/logging/logging.module.js';
import { PERSISTENCE } from '../infra/persistence/persistence.module.js';
import { CLOCK, SECRETS } from '../infra/providers/providers.module.js';
import { AppMetrics } from '../infra/telemetry/metrics.js';

export const RUN_LISTENERS = token<readonly RunLifecycleListener[]>('RUN_LISTENERS');

@Module({
  providers: [
    factoryProvider(
      NotificationEnqueuer,
      [PERSISTENCE, CLOCK],
      (persistence, clock) =>
        new NotificationEnqueuer({ outbox: persistence.outbox, groups: persistence.groups, clock }),
    ),
    factoryProvider(
      WorkflowRuntime,
      [PERSISTENCE, CLOCK, LOGGER],
      (persistence, clock, logger) => new WorkflowRuntime({ ...persistence, clock, logger }),
    ),
    factoryProvider(
      RUN_LISTENERS,
      [
        PERSISTENCE,
        ProviderRegistry,
        CLOCK,
        LOGGER,
        AppMetrics,
        NotificationEnqueuer,
        WorkflowRuntime,
      ],
      (persistence, registry, clock, logger, metrics, enqueuer, workflowRuntime) => [
        new AnalyticsListener(persistence.analytics),
        metrics,
        new NotificationListener(enqueuer),
        new ChainListener({ ...persistence, registry, clock, logger }),
        new WorkflowAdvancer(workflowRuntime),
      ],
    ),
    factoryProvider(
      JobService,
      [PERSISTENCE, ProviderRegistry, CLOCK, LOGGER, RUN_LISTENERS],
      (persistence, registry, clock, logger, listeners) =>
        new JobService({ ...persistence, registry, clock, logger, listeners }),
    ),
    factoryProvider(
      WorkflowService,
      [PERSISTENCE, ProviderRegistry, CLOCK, JobService, WorkflowRuntime],
      (persistence, registry, clock, jobService, runtime) =>
        new WorkflowService({ ...persistence, registry, clock, jobService, runtime }),
    ),
    factoryProvider(
      ConnectionService,
      [PERSISTENCE, ProviderRegistry, SECRETS, CLOCK],
      (persistence, registry, secrets, clock) =>
        new ConnectionService({ ...persistence, registry, secrets, clock }),
    ),
    factoryProvider(
      ConnectionExtractor,
      [PERSISTENCE, ProviderRegistry, CLOCK, JobService, ConnectionService],
      (persistence, registry, clock, jobService, connectionService) =>
        new ConnectionExtractor({ ...persistence, registry, clock, jobService, connectionService }),
    ),
    factoryProvider(
      EnvironmentService,
      [PERSISTENCE, CLOCK],
      (persistence, clock) => new EnvironmentService({ ...persistence, clock }),
    ),
    factoryProvider(
      GroupService,
      [PERSISTENCE, ProviderRegistry, CLOCK],
      (persistence, registry, clock) => new GroupService({ ...persistence, registry, clock }),
    ),
    factoryProvider(
      JobTransfer,
      [PERSISTENCE, ProviderRegistry, JobService],
      (persistence, registry, service) => new JobTransfer({ ...persistence, registry, service }),
    ),
    factoryProvider(
      EventIngestor,
      [PERSISTENCE, ProviderRegistry, SECRETS, CLOCK, LOGGER, ConfigService],
      (persistence, registry, secrets, clock, logger, { values }) =>
        new EventIngestor({
          ...persistence,
          registry,
          secrets,
          clock,
          logger,
          defaultWebhookPerSecond: values.WEBHOOK_MAX_PER_SECOND,
        }),
    ),
  ],
  exports: [
    injectionToken(RUN_LISTENERS),
    NotificationEnqueuer,
    WorkflowRuntime,
    JobService,
    WorkflowService,
    GroupService,
    ConnectionService,
    ConnectionExtractor,
    EnvironmentService,
    JobTransfer,
    EventIngestor,
  ],
})
export class EngineModule {}
