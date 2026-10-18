import {
  type Clock,
  ProviderRegistry,
  type SecretResolver,
  systemClock,
} from '@cloud-trigger/core';
import { awsProviders } from '@cloud-trigger/providers-aws';
import { builtinProviders, createFanoutTarget } from '@cloud-trigger/providers-builtin';
import { grpcProviders } from '@cloud-trigger/providers-grpc';
import { kafkaProviders } from '@cloud-trigger/providers-kafka';
import { natsProviders } from '@cloud-trigger/providers-nats';
import { Global, Module } from '@nestjs/common';

import { ShutdownHook } from '../../common/shutdown-hook.js';
import { factoryProvider, injectionToken, token, valueProvider } from '../../common/tokens.js';
import { ConfigService } from '../../config/config.module.js';
import { LOGGER } from '../logging/logging.module.js';
import { loadPlugins } from './plugins.js';
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
    factoryProvider(ProviderRegistry, [ConfigService, LOGGER], async ({ values }, logger) => {
      const registry = new ProviderRegistry().use(
        builtinProviders,
        grpcProviders,
        awsProviders,
        kafkaProviders,
        natsProviders,
      );
      const plugins = await loadPlugins(registry, values.PLUGINS);
      if (plugins.length > 0) {
        logger.info('Loaded provider plugins', { plugins });
      }
      registry.register(createFanoutTarget(registry));

      return registry;
    }),
    factoryProvider(
      token<ShutdownHook>('REGISTRY_SHUTDOWN'),
      [ProviderRegistry],
      (registry) => new ShutdownHook(() => registry.dispose()),
    ),
  ],
  exports: [injectionToken(CLOCK), injectionToken(SECRETS), ProviderRegistry],
})
export class ProvidersModule {}
