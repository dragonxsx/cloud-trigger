import type { ApiKeyRepository } from '@cloud-trigger/core';

import type { AccessService } from '../../auth/access-service.js';
import type { AuthSettingsCache } from '../../auth/settings-cache.js';
import { type Api, toApiError } from '../shared/api.js';

export interface SessionRouterDeps {
  readonly api: Api;
  readonly access: AccessService;
  readonly settings: AuthSettingsCache;
  readonly apiKeys: ApiKeyRepository;
}

export const sessionHandlers = ({ api, access, settings, apiKeys }: SessionRouterDeps) => {
  return {
    me: api.auth.me.handler(({ context }) => ({
      subject: context.principal.subject,
      name: context.principal.name,
      via: context.principal.via,
      scopes: [...context.principal.scopes],
    })),
    config: api.auth.config.handler(async () => {
      const current = await settings.get();
      if (!current) {
        return { setupRequired: true, local: false, oidc: null, apiKeys: false, anonymous: false };
      }
      const { oidc } = current;

      return {
        setupRequired: false,
        local: current.local.enabled,
        oidc:
          oidc.enabled && oidc.issuer !== undefined && oidc.clientId !== undefined
            ? { authority: oidc.issuer, clientId: oidc.clientId, scope: oidc.uiScope }
            : null,
        apiKeys: (await apiKeys.list()).some((key) => key.revokedAt === undefined),
        anonymous: current.anonymous.scopes.length > 0,
      };
    }),
    login: api.auth.login.handler(async ({ input, errors }) => {
      const session = await access.login(input.username, input.password);
      if (session.isErr()) {
        throw toApiError(errors, session.error);
      }

      return session.value;
    }),
    changePassword: api.auth.changePassword.handler(async ({ input, context, errors }) => {
      const session = await access.changePassword(
        context.principal,
        input.currentPassword,
        input.newPassword,
      );
      if (session.isErr()) {
        throw toApiError(errors, session.error);
      }

      return session.value;
    }),
  };
};

export class SessionRouter {
  constructor(readonly handlers: ReturnType<typeof sessionHandlers>) {}
}
