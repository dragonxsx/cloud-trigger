import { Module } from '@nestjs/common';

import { AccessService } from '../../auth/access-service.js';
import { factoryProvider } from '../../common/tokens.js';
import { ApiSharedModule, ORPC_API } from '../shared/api-shared.module.js';
import { AccessRouter, accessHandlers } from './access.router.js';

@Module({
  imports: [ApiSharedModule],
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
