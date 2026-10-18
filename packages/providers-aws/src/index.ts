import type { ProviderPlugin } from '@cloud-trigger/core';

import { sqsSource } from './sources/sqs.js';
import { eventBridgeTarget } from './targets/eventbridge.js';
import { snsTarget } from './targets/sns.js';
import { sqsTarget } from './targets/sqs.js';

export { EventBridgeTargetConfig, eventBridgeTarget } from './targets/eventbridge.js';
export { SnsTargetConfig, snsTarget } from './targets/sns.js';
export { SqsTargetConfig, sqsTarget } from './targets/sqs.js';
export { SqsSourceConfig, sqsSource } from './sources/sqs.js';

export const awsProviders: ProviderPlugin = {
  name: '@cloud-trigger/providers-aws',
  register: (registry) => {
    registry.register(sqsTarget, snsTarget, eventBridgeTarget, sqsSource);
  },
};

export default awsProviders;
