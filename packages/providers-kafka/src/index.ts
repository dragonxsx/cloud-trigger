import type { ProviderPlugin } from '@cloud-trigger/core';

import { kafkaConnection } from './connection.js';
import { kafkaSource } from './kafka-source.js';
import { closeProducers, kafkaTarget } from './kafka-target.js';

export { KafkaConnectionConfig, kafkaConnection } from './connection.js';
export { KafkaSourceConfig, kafkaSource } from './kafka-source.js';
export { KafkaTargetConfig, kafkaTarget } from './kafka-target.js';

export const kafkaProviders: ProviderPlugin = {
  name: '@cloud-trigger/providers-kafka',
  register: (registry) => {
    registry.register(kafkaConnection, kafkaTarget, kafkaSource);
  },
  dispose: closeProducers,
};

export default kafkaProviders;
