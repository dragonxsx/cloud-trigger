import { contract } from '@cloud-trigger/api-contract';
import { Controller, Inject } from '@nestjs/common';
import { Implement } from '@orpc/nest';

import type { AppContext } from '../app-context.js';
import { APP_CONTEXT } from '../tokens.js';
import { type Api, createApi } from './api.js';

@Controller()
export class AnalyticsController {
  readonly #api: Api;

  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {
    this.#api = createApi(ctx);
  }

  @Implement(contract.analytics)
  analytics() {
    const { analytics } = this.ctx.persistence;
    const api = this.#api.analytics;

    return {
      summary: api.summary.handler(({ input }) => analytics.summary(input)),
      timeseries: api.timeseries.handler(async ({ input }) => [
        ...(await analytics.timeseries(input)),
      ]),
      topErrors: api.topErrors.handler(async ({ input }) => [
        ...(await analytics.topErrors(input)),
      ]),
    };
  }
}

@Controller()
export class ProvidersController {
  readonly #api: Api;

  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {
    this.#api = createApi(ctx);
  }

  @Implement(contract.providers)
  providers() {
    return {
      list: this.#api.providers.list.handler(({ input }) =>
        this.ctx.registry
          .list(input.kind)
          .map((p) => ({ ...p, configSchema: { ...p.configSchema } })),
      ),
    };
  }
}

@Controller()
export class AuthController {
  readonly #api: Api;

  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {
    this.#api = createApi(ctx);
  }

  @Implement(contract.auth)
  auth() {
    return {
      me: this.#api.auth.me.handler(({ context }) => ({
        ...context.principal,
        scopes: [...context.principal.scopes],
      })),
      config: this.#api.auth.config.handler(() => {
        const { config } = this.ctx;

        return {
          oidc:
            config.OIDC_ISSUER && config.OIDC_CLIENT_ID
              ? {
                  authority: config.OIDC_ISSUER,
                  clientId: config.OIDC_CLIENT_ID,
                  scope: config.OIDC_UI_SCOPE,
                }
              : null,
          apiKeys: config.API_KEYS.length > 0,
          anonymous: config.ANONYMOUS_SCOPES.length > 0,
        };
      }),
    };
  }
}
