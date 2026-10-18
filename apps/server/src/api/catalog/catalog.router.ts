import type { ProviderRegistry } from '@cloud-trigger/core';

import type { Api } from '../shared/api.js';

export interface CatalogRouterDeps {
  readonly api: Api;
  readonly registry: ProviderRegistry;
}

export const catalogHandlers = ({ api, registry }: CatalogRouterDeps) => {
  return {
    list: api.providers.list.handler(({ input }) =>
      registry.list(input.kind).map((p) => ({ ...p, configSchema: { ...p.configSchema } })),
    ),
  };
};

export class CatalogRouter {
  constructor(readonly handlers: ReturnType<typeof catalogHandlers>) {}
}
