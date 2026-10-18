import { contract } from '@cloud-trigger/api-contract';
import { Controller, Inject } from '@nestjs/common';
import { Implement } from '@orpc/nest';

import type { AppContext } from '../app-context.js';
import { APP_CONTEXT } from '../tokens.js';
import { type Api, createApi, toApiError } from './api.js';
import { JobRedactor } from './redaction.js';

@Controller()
export class GroupsController {
  readonly #api: Api;
  readonly #redactor: JobRedactor;

  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {
    this.#api = createApi(ctx);
    this.#redactor = new JobRedactor(ctx.registry);
  }

  @Implement(contract.groups)
  groups() {
    const { groupService } = this.ctx;
    const groups = this.#api.groups;
    const redact = this.#redactor.redactGroup.bind(this.#redactor);

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
          this.#redactor.restoreGroup(spec, previous),
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
  }
}
