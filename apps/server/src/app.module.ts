import type { Tracer } from '@cloud-trigger/core';
import { type DynamicModule, Module } from '@nestjs/common';
import type { Logger as Pino } from 'pino';

import { ApiModule } from './api/api.module.js';
import type { AppConfig } from './config/config.js';
import { ConfigModule } from './config/config.module.js';
import { RuntimeModule } from './engine/runtime.module.js';
import { FeedsModule } from './feeds/feeds.module.js';
import { HealthModule } from './health/health.module.js';
import { HooksModule } from './hooks/hooks.module.js';
import { LoggingModule } from './infra/logging/logging.module.js';
import { PersistenceModule } from './infra/persistence/persistence.module.js';
import { ProvidersModule } from './infra/providers/providers.module.js';
import { TelemetryModule } from './infra/telemetry/telemetry.module.js';
import { McpModule } from './mcp/mcp.module.js';
import { WebModule } from './web/web.module.js';

export interface AppModuleOptions {
  readonly config: AppConfig;
  readonly pino: Pino;
  readonly tracer?: Tracer | undefined;
}

@Module({})
export class AppModule {
  static forRoot({ config, pino, tracer }: AppModuleOptions): DynamicModule {
    const servesApi = config.APP_ROLE.includes('api');
    const webDist = config.WEB_DIST;

    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        LoggingModule.forRoot(pino),
        TelemetryModule.forRoot({ tracer }),
        PersistenceModule,
        ProvidersModule,
        HealthModule,
        RuntimeModule,
        ...(servesApi ? [ApiModule, FeedsModule, HooksModule, McpModule] : []),
        ...(servesApi && webDist ? [WebModule.forRoot(webDist)] : []),
      ],
    };
  }
}
