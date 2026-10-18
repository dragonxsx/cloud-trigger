import type { GroupService } from '@cloud-trigger/engine';

import { type Api, toApiError } from '../shared/api.js';
import type { JobRedactor } from '../shared/redaction.js';

export interface GroupsRouterDeps {
  readonly api: Api;
  readonly groupService: GroupService;
  readonly redactor: JobRedactor;
}

export const groupsHandlers = ({ api, groupService, redactor }: GroupsRouterDeps) => {
  const groups = api.groups;
  const redact = redactor.redactGroup.bind(redactor);

  return {
    list: groups.list.handler(async ({ input }) => {
      const page = await groupService.list(input);

      return { items: page.items.map(redact), nextCursor: page.nextCursor, total: page.total };
    }),

    get: groups.get.handler(async ({ input, errors }) => {
      const group = await groupService.get(input.id);
      if (!group) {
        throw errors.NOT_FOUND({ message: `Group ${input.id} not found` });
      }

      return redact(group);
    }),

    create: groups.create.handler(async ({ input, errors }) => {
      const created = await groupService.create(input);
      if (created.isErr()) {
        throw toApiError(errors, created.error);
      }

      return redact(created.value);
    }),

    update: groups.update.handler(async ({ input, errors }) => {
      const { id, expectedVersion, ...spec } = input;
      const previous = await groupService.get(id);
      if (!previous) {
        throw errors.NOT_FOUND({ message: `Group ${id} not found` });
      }
      const updated = await groupService.update(
        id,
        redactor.restoreGroup(spec, previous),
        expectedVersion,
      );
      if (updated.isErr()) {
        throw toApiError(errors, updated.error);
      }

      return redact(updated.value);
    }),

    delete: groups.delete.handler(async ({ input, errors }) => {
      const deleted = await groupService.delete(input.id);
      if (deleted.isErr()) {
        throw toApiError(errors, deleted.error);
      }

      return { deleted: true };
    }),
  };
};

export class GroupsRouter {
  constructor(readonly handlers: ReturnType<typeof groupsHandlers>) {}
}
