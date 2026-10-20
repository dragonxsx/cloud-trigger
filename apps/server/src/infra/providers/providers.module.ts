import {
  type Clock,
  ProviderRegistry,
  type SecretResolver,
  systemClock,
} from '@cloud-trigger/core';
import { Global, Module } from '@nestjs/common';

import { ShutdownHook } from '../../common/shutdown-hook.js';
import { factoryProvider, injectionToken, token, valueProvider } from '../../common/tokens.js';
import { ConfigService } from '../../config/config.module.js';
import { LOGGER } from '../logging/logging.module.js';
import { createProviderRegistry } from './registry.js';
import { envAndFileSecretResolver } from './secrets.js';

export const CLOCK = token<Clock>('CLOCK');
export const SECRETS = token<SecretResolver>('SECRETS');

@Global()
@Module({
  providers: [
    valueProvider(CLOCK, systemClock),
    factoryProvider(SECRETS, [ConfigService], ({ values }) =>
      envAndFileSecretResolver({ prefix: values.SECRET_ENV_PREFIX, dir: values.SECRETS_DIR }),
    ),
    factoryProvider(ProviderRegistry, [ConfigService, LOGGER], ({ values }, logger) =>
      createProviderRegistry(values.PLUGINS, logger),
    ),
    factoryProvider(
      token<ShutdownHook>('REGISTRY_SHUTDOWN'),
      [ProviderRegistry],
      (registry) => new ShutdownHook(() => registry.dispose()),
    ),
  ],
  exports: [injectionToken(CLOCK), injectionToken(SECRETS), ProviderRegistry],
})
export class ProvidersModule {}
