import { ConnectionService } from '@cloud-trigger/engine';
import { MAX_SPEC_BYTES } from '@cloud-trigger/openapi';
import { Module } from '@nestjs/common';

import { ShutdownHook } from '../../common/shutdown-hook.js';
import { factoryProvider, token } from '../../common/tokens.js';
import { ConfigService } from '../../config/config.module.js';
import { EngineModule } from '../../engine/engine.module.js';
import { SPEC_FETCHER, createSpecFetcher } from '../../infra/http/spec-fetcher.js';
import { ApiSharedModule, ORPC_API } from '../shared/api-shared.module.js';
import { JobRedactor } from '../shared/redaction.js';
import { ConnectionsRouter, connectionsHandlers } from './connections.router.js';

const SPEC_FETCH_TIMEOUT_MS = 10_000;

@Module({
  imports: [ApiSharedModule, EngineModule],
  providers: [
    factoryProvider(SPEC_FETCHER, [ConfigService], ({ values }) =>
      createSpecFetcher({
        allowPrivate: values.OPENAPI_FETCH_ALLOW_PRIVATE,
        maxBytes: MAX_SPEC_BYTES,
        timeoutMs: SPEC_FETCH_TIMEOUT_MS,
      }),
    ),
    factoryProvider(
      token<ShutdownHook>('SPEC_FETCHER_SHUTDOWN'),
      [SPEC_FETCHER],
      (fetcher) => new ShutdownHook(() => fetcher.close()),
    ),
    factoryProvider(
      ConnectionsRouter,
      [ORPC_API, ConnectionService, JobRedactor, SPEC_FETCHER],
      (api, connectionService, redactor, specFetcher) =>
        new ConnectionsRouter(
          connectionsHandlers({ api, connectionService, redactor, specFetcher }),
        ),
    ),
  ],
  exports: [ConnectionsRouter],
})
export class ConnectionsModule {}
