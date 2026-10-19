import type { ApiKey, AuthSettings, User } from '@cloud-trigger/core';

import type { AccessService } from '../../auth/access-service.js';
import { type Api, toApiError } from '../shared/api.js';

export interface AccessRouterDeps {
  readonly api: Api;
  readonly access: AccessService;
}

const settingsView = (settings: AuthSettings) => ({
  local: settings.local,
  oidc: settings.oidc,
  anonymous: settings.anonymous,
  version: settings.version,
  updatedAt: settings.updatedAt,
});

const userView = ({ passwordHash: _hash, tokenVersion: _tokens, ...user }: User) => user;

const apiKeyView = ({ hash: _hash, ...key }: ApiKey) => key;

export const accessHandlers = ({ api, access }: AccessRouterDeps) => ({
  authSettings: {
    get: api.authSettings.get.handler(async ({ errors }) => {
      const settings = await access.getSettings();
      if (settings.isErr()) {
        throw toApiError(errors, settings.error);
      }

      return settingsView(settings.value);
    }),
    update: api.authSettings.update.handler(async ({ input, errors }) => {
      const { expectedVersion, ...methods } = input;
      const updated = await access.updateSettings(methods, expectedVersion);
      if (updated.isErr()) {
        throw toApiError(errors, updated.error);
      }

      return settingsView(updated.value);
    }),
    rotateSessionSecret: api.authSettings.rotateSessionSecret.handler(async ({ errors }) => {
      const rotated = await access.rotateSessionSecret();
      if (rotated.isErr()) {
        throw toApiError(errors, rotated.error);
      }

      return settingsView(rotated.value);
    }),
  },

  users: {
    list: api.users.list.handler(async ({ input }) => {
      const page = await access.listUsers(input);

      return { items: page.items.map(userView), nextCursor: page.nextCursor, total: page.total };
    }),
    create: api.users.create.handler(async ({ input, errors }) => {
      const created = await access.createUser(input);
      if (created.isErr()) {
        throw toApiError(errors, created.error);
      }

      return userView(created.value);
    }),
    get: api.users.get.handler(async ({ input, errors }) => {
      const user = await access.getUser(input.id);
      if (user.isErr()) {
        throw toApiError(errors, user.error);
      }

      return userView(user.value);
    }),
    update: api.users.update.handler(async ({ input, errors }) => {
      const updated = await access.updateUser(input);
      if (updated.isErr()) {
        throw toApiError(errors, updated.error);
      }

      return userView(updated.value);
    }),
    delete: api.users.delete.handler(async ({ input, errors }) => {
      const deleted = await access.deleteUser(input.id);
      if (deleted.isErr()) {
        throw toApiError(errors, deleted.error);
      }

      return { deleted: deleted.value };
    }),
    resetPassword: api.users.resetPassword.handler(async ({ input, errors }) => {
      const updated = await access.resetPassword(input.id, input.password);
      if (updated.isErr()) {
        throw toApiError(errors, updated.error);
      }

      return userView(updated.value);
    }),
  },

  apiKeys: {
    list: api.apiKeys.list.handler(async () => (await access.listApiKeys()).map(apiKeyView)),
    create: api.apiKeys.create.handler(async ({ input, errors }) => {
      const created = await access.createApiKey(input);
      if (created.isErr()) {
        throw toApiError(errors, created.error);
      }

      return { ...apiKeyView(created.value.apiKey), key: created.value.key };
    }),
    revoke: api.apiKeys.revoke.handler(async ({ input }) => ({
      revoked: await access.revokeApiKey(input.id),
    })),
  },
});

export class AccessRouter {
  constructor(readonly handlers: ReturnType<typeof accessHandlers>) {}
}
