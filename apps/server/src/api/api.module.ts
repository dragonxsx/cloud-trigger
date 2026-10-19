import { Module } from '@nestjs/common';
import { ORPCModule, onError } from '@orpc/nest';
import { RequestHeadersPlugin } from '@orpc/server/plugins';
import { experimental_ZodSmartCoercionPlugin as ZodSmartCoercionPlugin } from '@orpc/zod/zod4';

import { factory, factoryProvider } from '../common/tokens.js';
import { LOGGER } from '../infra/logging/logging.module.js';
import { AccessModule } from './access/access.module.js';
import { AnalyticsModule } from './analytics/analytics.module.js';
import { ApiController } from './api.controller.js';
import { APP_ROUTER_PARTS, ApiRouter, composeAppRouter } from './app-router.js';
import { CalendarModule } from './calendar/calendar.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { ConnectionsModule } from './connections/connections.module.js';
import { GroupsModule } from './groups/groups.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { OpenApiController } from './openapi.controller.js';
import { RunsModule } from './runs/runs.module.js';
import { SessionModule } from './session/session.module.js';
import { SetupModule } from './setup/setup.module.js';
import { WorkflowsModule } from './workflows/workflows.module.js';

export const orpcRootModule = () =>
  ORPCModule.forRootAsync(
    factory([LOGGER], (logger) => ({
      context: {},
      plugins: [new RequestHeadersPlugin(), new ZodSmartCoercionPlugin()],
      interceptors: [
        onError((error) => {
          logger.debug('API procedure error', { err: error });
        }),
      ],
    })),
  );

@Module({
  imports: [
    orpcRootModule(),
    JobsModule,
    RunsModule,
    GroupsModule,
    ConnectionsModule,
    WorkflowsModule,
    CalendarModule,
    AnalyticsModule,
    CatalogModule,
    SessionModule,
    SetupModule,
    AccessModule,
  ],
  controllers: [ApiController, OpenApiController],
  providers: [
    factoryProvider(
      ApiRouter,
      APP_ROUTER_PARTS,
      (...parts) => new ApiRouter(composeAppRouter(...parts)),
    ),
  ],
  exports: [ApiRouter],
})
export class ApiModule {}
