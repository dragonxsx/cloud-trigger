import { Module } from '@nestjs/common';

import { factoryProvider } from '../../common/tokens.js';
import { PERSISTENCE } from '../../infra/persistence/persistence.module.js';
import { ApiSharedModule, ORPC_API } from '../shared/api-shared.module.js';
import { AnalyticsRouter, analyticsHandlers } from './analytics.router.js';

@Module({
  imports: [ApiSharedModule],
  providers: [
    factoryProvider(
      AnalyticsRouter,
      [ORPC_API, PERSISTENCE],
      (api, persistence) =>
        new AnalyticsRouter(analyticsHandlers({ api, analytics: persistence.analytics })),
    ),
  ],
  exports: [AnalyticsRouter],
})
export class AnalyticsModule {}
