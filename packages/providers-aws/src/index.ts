import type { ProviderPlugin } from '@cloud-trigger/core';

import { awsConnection } from './connection.js';
import { sqsSource } from './sources/sqs.js';
import { eventBridgeTarget } from './targets/eventbridge.js';
import { snsTarget } from './targets/sns.js';
import { sqsTarget } from './targets/sqs.js';

export { awsConnection } from './connection.js';
export { AwsConnectionConfig } from './shared.js';
export { EventBridgeTargetConfig, eventBridgeTarget } from './targets/eventbridge.js';
export { SnsTargetConfig, snsTarget } from './targets/sns.js';
export { SqsTargetConfig, sqsTarget } from './targets/sqs.js';
export { SqsSourceConfig, sqsSource } from './sources/sqs.js';

export const awsProviders: ProviderPlugin = {
  name: '@cloud-trigger/providers-aws',
  register: (registry) => {
    registry.register(awsConnection, sqsTarget, snsTarget, eventBridgeTarget, sqsSource);
  },
};

export default awsProviders;
