import { Module } from '@nestjs/common';

import { factoryProvider } from '../../common/tokens.js';
import { ConfigService } from '../../config/config.module.js';
import { ApiSharedModule, ORPC_API } from '../shared/api-shared.module.js';
import { SessionController } from './session.controller.js';
import { SessionRouter, sessionHandlers } from './session.router.js';

@Module({
  imports: [ApiSharedModule],
  controllers: [SessionController],
  providers: [
    factoryProvider(
      SessionRouter,
      [ORPC_API, ConfigService],
      (api, { values }) => new SessionRouter(sessionHandlers({ api, config: values })),
    ),
  ],
  exports: [SessionRouter],
})
export class SessionModule {}
