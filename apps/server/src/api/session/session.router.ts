import type { AppConfig } from '../../config/config.js';
import type { Api } from '../shared/api.js';

export interface SessionRouterDeps {
  readonly api: Api;
  readonly config: AppConfig;
}

export const sessionHandlers = ({ api, config }: SessionRouterDeps) => {
  return {
    me: api.auth.me.handler(({ context }) => ({
      ...context.principal,
      scopes: [...context.principal.scopes],
    })),
    config: api.auth.config.handler(() => ({
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
    })),
  };
};

export class SessionRouter {
  constructor(readonly handlers: ReturnType<typeof sessionHandlers>) {}
}
