import { ProviderRegistry } from '@cloud-trigger/core';
import { EventIngestor, NotificationEnqueuer, WorkflowRuntime } from '@cloud-trigger/engine';
import { Module } from '@nestjs/common';

import { factoryProvider } from '../common/tokens.js';
import { ConfigService } from '../config/config.module.js';
import { LOGGER } from '../infra/logging/logging.module.js';
import { PERSISTENCE } from '../infra/persistence/persistence.module.js';
import { CLOCK, SECRETS } from '../infra/providers/providers.module.js';
import { AppMetrics } from '../infra/telemetry/metrics.js';
import { TRACING } from '../infra/telemetry/telemetry.module.js';
import { createBackgroundLoops } from './background-loops.js';
import { EngineRuntime } from './engine-runtime.js';
import { EngineModule, RUN_LISTENERS } from './engine.module.js';

@Module({
  imports: [EngineModule],
  providers: [
    factoryProvider(
      EngineRuntime,
      [
        ConfigService,
        PERSISTENCE,
        ProviderRegistry,
        SECRETS,
        CLOCK,
        LOGGER,
        TRACING,
        AppMetrics,
        RUN_LISTENERS,
        NotificationEnqueuer,
        WorkflowRuntime,
        EventIngestor,
      ],
      (
        { values: config },
        persistence,
        registry,
        secrets,
        clock,
        logger,
        { tracer },
        metrics,
        listeners,
        enqueuer,
        workflowRuntime,
        ingestor,
      ) =>
        new EngineRuntime(
          createBackgroundLoops({
            config,
            persistence,
            registry,
            secrets,
            clock,
            logger,
            tracer,
            metrics,
            listeners,
            enqueuer,
            workflowRuntime,
            ingestor,
          }),
          logger,
        ),
    ),
  ],
  exports: [EngineRuntime],
})
export class RuntimeModule {}
