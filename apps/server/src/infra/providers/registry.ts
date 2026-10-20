import { type Logger, ProviderRegistry } from '@cloud-trigger/core';
import { awsProviders } from '@cloud-trigger/providers-aws';
import { builtinProviders, createFanoutTarget } from '@cloud-trigger/providers-builtin';
import { grpcProviders } from '@cloud-trigger/providers-grpc';
import { kafkaProviders } from '@cloud-trigger/providers-kafka';
import { natsProviders } from '@cloud-trigger/providers-nats';

import { loadPlugins } from './plugins.js';

export async function createProviderRegistry(
  plugins: readonly string[],
  logger: Logger,
): Promise<ProviderRegistry> {
  const registry = new ProviderRegistry().use(
    builtinProviders,
    grpcProviders,
    awsProviders,
    kafkaProviders,
    natsProviders,
  );
  const loaded = await loadPlugins(registry, plugins);
  if (loaded.length > 0) {
    logger.info('Loaded provider plugins', { plugins: loaded });
  }
  registry.register(createFanoutTarget(registry));

  return registry;
}
