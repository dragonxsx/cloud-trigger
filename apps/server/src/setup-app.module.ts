import { type ConfigIssue, err } from '@cloud-trigger/core';
import { type DynamicModule, Module } from '@nestjs/common';
import type { Logger as Pino } from 'pino';

import { orpcRootModule } from './api/api.module.js';
import { SetupAnnouncer } from './api/setup/setup-announcer.js';
import { SetupController } from './api/setup/setup.controller.js';
import { type SetupBackend, SetupRouter, setupHandlers } from './api/setup/setup.router.js';
import { createApi } from './api/shared/api.js';
import type { Authenticate } from './auth/authenticator.js';
import { SetupToken } from './auth/setup-token.js';
import { factoryProvider, valueProvider } from './common/tokens.js';
import type { AppConfig } from './config/config.js';
import { inferDriver } from './config/config.js';
import { ConfigModule, ConfigService } from './config/config.module.js';
import { HealthController } from './health/health.controller.js';
import { Readiness } from './health/readiness.js';
import { LOGGER, LoggingModule } from './infra/logging/logging.module.js';
import { WebModule } from './web/web.module.js';

export interface SetupAppModuleOptions {
  readonly config: AppConfig;
  readonly pino: Pino;
  readonly issues: readonly ConfigIssue[];
}

const noCredentials: Authenticate = { authenticate: () => Promise.resolve('setup_required') };

@Module({})
export class SetupAppModule {
  static forRoot({ config, pino, issues }: SetupAppModuleOptions): DynamicModule {
    const backend: SetupBackend = {
      stage: () => Promise.resolve('database'),
      database: { driver: inferDriver(config) ?? null, issues },
      complete: () =>
        Promise.resolve(
          err({ code: 'conflict', message: 'Configure the database and restart the server first' }),
        ),
    };

    return {
      module: SetupAppModule,
      imports: [
        ConfigModule.forRoot(config),
        LoggingModule.forRoot(pino),
        orpcRootModule(),
        ...(config.WEB_DIST ? [WebModule.forRoot(config.WEB_DIST)] : []),
      ],
      controllers: [SetupController, HealthController],
      providers: [
        valueProvider(SetupToken, new SetupToken(config.SETUP_TOKEN)),
        factoryProvider(
          SetupRouter,
          [SetupToken],
          (token) =>
            new SetupRouter(
              setupHandlers({
                api: createApi(noCredentials),
                backend,
                token,
                authenticator: noCredentials,
              }),
            ),
        ),
        valueProvider(Readiness, new Readiness(() => Promise.resolve(false), config.APP_ROLE)),
        factoryProvider(
          SetupAnnouncer,
          [SetupToken, LOGGER, ConfigService],
          (token, logger, { values }) =>
            new SetupAnnouncer(backend, token, logger, values.PUBLIC_URL),
        ),
      ],
    };
  }
}
