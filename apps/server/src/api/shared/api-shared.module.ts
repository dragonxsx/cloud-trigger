import { ProviderRegistry } from '@cloud-trigger/core';
import { Module } from '@nestjs/common';

import { AuthModule } from '../../auth/auth.module.js';
import { Authenticator } from '../../auth/authenticator.js';
import { factoryProvider, injectionToken, token } from '../../common/tokens.js';
import { type Api, createApi } from './api.js';
import { JobRedactor } from './redaction.js';

export const ORPC_API = token<Api>('ORPC_API');

@Module({
  imports: [AuthModule],
  providers: [
    factoryProvider(ORPC_API, [Authenticator], (authenticator) => createApi(authenticator)),
    factoryProvider(JobRedactor, [ProviderRegistry], (registry) => new JobRedactor(registry)),
  ],
  exports: [AuthModule, injectionToken(ORPC_API), JobRedactor],
})
export class ApiSharedModule {}
