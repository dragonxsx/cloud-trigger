import { ProviderRegistry } from '@cloud-trigger/core';
import { Module } from '@nestjs/common';

import { factoryProvider } from '../../common/tokens.js';
import { ApiSharedModule, ORPC_API } from '../shared/api-shared.module.js';
import { CatalogRouter, catalogHandlers } from './catalog.router.js';

@Module({
  imports: [ApiSharedModule],
  providers: [
    factoryProvider(
      CatalogRouter,
      [ORPC_API, ProviderRegistry],
      (api, registry) => new CatalogRouter(catalogHandlers({ api, registry })),
    ),
  ],
  exports: [CatalogRouter],
})
export class CatalogModule {}
