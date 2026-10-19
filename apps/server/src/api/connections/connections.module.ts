import { ConnectionService } from '@cloud-trigger/engine';
import { Module } from '@nestjs/common';

import { factoryProvider } from '../../common/tokens.js';
import { EngineModule } from '../../engine/engine.module.js';
import { ApiSharedModule, ORPC_API } from '../shared/api-shared.module.js';
import { JobRedactor } from '../shared/redaction.js';
import { ConnectionsRouter, connectionsHandlers } from './connections.router.js';

@Module({
  imports: [ApiSharedModule, EngineModule],
  providers: [
    factoryProvider(
      ConnectionsRouter,
      [ORPC_API, ConnectionService, JobRedactor],
      (api, connectionService, redactor) =>
        new ConnectionsRouter(connectionsHandlers({ api, connectionService, redactor })),
    ),
  ],
  exports: [ConnectionsRouter],
})
export class ConnectionsModule {}
