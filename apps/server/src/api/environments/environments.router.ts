import type { EnvironmentService } from '@cloud-trigger/engine';

import { type Api, toApiError } from '../shared/api.js';

export interface EnvironmentsRouterDeps {
  readonly api: Api;
  readonly environmentService: EnvironmentService;
}

export const environmentsHandlers = ({ api, environmentService }: EnvironmentsRouterDeps) => {
  const environments = api.environments;

  return {
    list: environments.list.handler(async ({ input }) => {
      const page = await environmentService.list(input);

      return { ...page, items: [...page.items] };
    }),

    create: environments.create.handler(async ({ input, errors }) => {
      const created = await environmentService.create(input);
      if (created.isErr()) {
        throw toApiError(errors, created.error);
      }

      return created.value;
    }),

    get: environments.get.handler(async ({ input, errors }) => {
      const environment = await environmentService.get(input.key);
      if (environment.isErr()) {
        throw toApiError(errors, environment.error);
      }

      return environment.value;
    }),

    update: environments.update.handler(async ({ input, errors }) => {
      const { expectedVersion, ...spec } = input;
      const updated = await environmentService.update(spec.key, spec, expectedVersion);
      if (updated.isErr()) {
        throw toApiError(errors, updated.error);
      }

      return updated.value;
    }),

    delete: environments.delete.handler(async ({ input, errors }) => {
      const deleted = await environmentService.delete(input.key);
      if (deleted.isErr()) {
        throw toApiError(errors, deleted.error);
      }

      return { deleted: true };
    }),
  };
};

export class EnvironmentsRouter {
  constructor(readonly handlers: ReturnType<typeof environmentsHandlers>) {}
}
