import { Module } from '@nestjs/common';

import { AccessService } from '../../auth/access-service.js';
import { factoryProvider } from '../../common/tokens.js';
import { ApiSharedModule, ORPC_API } from '../shared/api-shared.module.js';
import { AccessController } from './access.controller.js';
import { AccessRouter, accessHandlers } from './access.router.js';

@Module({
  imports: [ApiSharedModule],
  controllers: [AccessController],
  providers: [
    factoryProvider(
      AccessRouter,
      [ORPC_API, AccessService],
      (api, access) => new AccessRouter(accessHandlers({ api, access })),
    ),
  ],
  exports: [AccessRouter],
})
export class AccessModule {}
