import { Module } from '@nestjs/common';

import { AccessService } from '../../auth/access-service.js';
import { AuthSettingsCache } from '../../auth/settings-cache.js';
import { factoryProvider } from '../../common/tokens.js';
import { PERSISTENCE } from '../../infra/persistence/persistence.module.js';
import { ApiSharedModule, ORPC_API } from '../shared/api-shared.module.js';
import { SessionRouter, sessionHandlers } from './session.router.js';

@Module({
  imports: [ApiSharedModule],
  providers: [
    factoryProvider(
      SessionRouter,
      [ORPC_API, AccessService, AuthSettingsCache, PERSISTENCE],
      (api, access, settings, { apiKeys }) =>
        new SessionRouter(sessionHandlers({ api, access, settings, apiKeys })),
    ),
  ],
  exports: [SessionRouter],
})
export class SessionModule {}
