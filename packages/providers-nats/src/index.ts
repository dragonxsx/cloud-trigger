import type { ProviderPlugin } from '@cloud-trigger/core';

import { natsSource } from './nats-source.js';
import { closeConnections, natsTarget } from './nats-target.js';

export { NatsSourceConfig, natsSource } from './nats-source.js';
export { NatsTargetConfig, natsTarget } from './nats-target.js';

export const natsProviders: ProviderPlugin = {
  name: '@cloud-trigger/providers-nats',
  register: (registry) => {
    registry.register(natsTarget, natsSource);
  },
  dispose: closeConnections,
};

export default natsProviders;
