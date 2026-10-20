import { EnvironmentService } from '@cloud-trigger/engine';
import { Module } from '@nestjs/common';

import { factoryProvider } from '../../common/tokens.js';
import { EngineModule } from '../../engine/engine.module.js';
import { ApiSharedModule, ORPC_API } from '../shared/api-shared.module.js';
import { EnvironmentsRouter, environmentsHandlers } from './environments.router.js';

@Module({
  imports: [ApiSharedModule, EngineModule],
  providers: [
    factoryProvider(
      EnvironmentsRouter,
      [ORPC_API, EnvironmentService],
      (api, environmentService) =>
        new EnvironmentsRouter(environmentsHandlers({ api, environmentService })),
    ),
  ],
  exports: [EnvironmentsRouter],
})
export class EnvironmentsModule {}
