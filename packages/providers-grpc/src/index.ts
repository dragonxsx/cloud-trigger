import type { ProviderPlugin } from '@cloud-trigger/core';

import { grpcTarget } from './grpc-target.js';

export { GrpcTargetConfig, grpcTarget } from './grpc-target.js';

export const grpcProviders: ProviderPlugin = {
  name: '@cloud-trigger/providers-grpc',
  register: (registry) => {
    registry.register(grpcTarget);
  },
};

export default grpcProviders;
