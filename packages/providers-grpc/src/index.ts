import type { ProviderPlugin } from '@cloud-trigger/core';

import { grpcConnection, grpcTarget } from './grpc-target.js';

export {
  GrpcConnectionConfig,
  GrpcTargetConfig,
  grpcConnection,
  grpcTarget,
} from './grpc-target.js';

export const grpcProviders: ProviderPlugin = {
  name: '@cloud-trigger/providers-grpc',
  register: (registry) => {
    registry.register(grpcConnection, grpcTarget);
  },
};

export default grpcProviders;
