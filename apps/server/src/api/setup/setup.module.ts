import { Module } from '@nestjs/common';

import { AccessService } from '../../auth/access-service.js';
import { Authenticator } from '../../auth/authenticator.js';
import { SetupToken } from '../../auth/setup-token.js';
import { factoryProvider, token } from '../../common/tokens.js';
import { inferDriver } from '../../config/config.js';
import { ConfigService } from '../../config/config.module.js';
import { LOGGER } from '../../infra/logging/logging.module.js';
import { ApiSharedModule, ORPC_API } from '../shared/api-shared.module.js';
import { SetupAnnouncer } from './setup-announcer.js';
import { type SetupBackend, SetupRouter, setupHandlers } from './setup.router.js';

const SETUP_BACKEND = token<SetupBackend>('SETUP_BACKEND');

@Module({
  imports: [ApiSharedModule],
  providers: [
    factoryProvider(
      SETUP_BACKEND,
      [AccessService, ConfigService],
      (access, { values }): SetupBackend => ({
        stage: async () => ((await access.isSetUp()) ? 'done' : 'auth'),
        database: { driver: inferDriver(values) ?? null, issues: [] },
        complete: (p) => access.completeSetup(p),
      }),
    ),
    factoryProvider(
      SetupRouter,
      [ORPC_API, SETUP_BACKEND, SetupToken, Authenticator],
      (api, backend, setupToken, authenticator) =>
        new SetupRouter(setupHandlers({ api, backend, token: setupToken, authenticator })),
    ),
    factoryProvider(
      SetupAnnouncer,
      [SETUP_BACKEND, SetupToken, LOGGER, ConfigService],
      (backend, setupToken, logger, { values }) =>
        new SetupAnnouncer(backend, setupToken, logger, values.PUBLIC_URL),
    ),
  ],
  exports: [SetupRouter],
})
export class SetupModule {}
