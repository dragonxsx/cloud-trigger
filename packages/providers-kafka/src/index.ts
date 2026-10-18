import type { ProviderPlugin } from '@cloud-trigger/core';

import { kafkaSource } from './kafka-source.js';
import { closeProducers, kafkaTarget } from './kafka-target.js';

export { KafkaSourceConfig, kafkaSource } from './kafka-source.js';
export { KafkaTargetConfig, kafkaTarget } from './kafka-target.js';

export const kafkaProviders: ProviderPlugin = {
  name: '@cloud-trigger/providers-kafka',
  register: (registry) => {
    registry.register(kafkaTarget, kafkaSource);
  },
  dispose: closeProducers,
};

export default kafkaProviders;
