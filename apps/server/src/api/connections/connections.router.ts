import type { ConnectionRef } from '@cloud-trigger/core';
import type { ConnectionService } from '@cloud-trigger/engine';

import { type Api, toApiError } from '../shared/api.js';
import type { JobRedactor } from '../shared/redaction.js';

export interface ConnectionsRouterDeps {
  readonly api: Api;
  readonly connectionService: ConnectionService;
  readonly redactor: JobRedactor;
}

export const connectionsHandlers = ({
  api,
  connectionService,
  redactor,
}: ConnectionsRouterDeps) => {
  const connections = api.connections;
  const redact = redactor.redactConnection.bind(redactor);

  return {
    test: connections.test.handler(async ({ input, errors }) => {
      let config = input.config;
      if (input.key !== undefined) {
        const previous = await connectionService.get(input.key);
        if (previous.isErr()) {
          throw toApiError(errors, previous.error);
        }
        config = redactor.restoreConnectionConfig(input, previous.value);
      }
      const tested = await connectionService.test({ type: input.type, config });
      if (tested.isErr()) {
        throw toApiError(errors, tested.error);
      }

      return tested.value.match(
        ({ message }) => ({ ok: true, message }),
        ({ message }) => ({ ok: false, message }),
      );
    }),

    list: connections.list.handler(async ({ input }) => {
      const page = await connectionService.list(input);

      return { items: page.items.map(redact), nextCursor: page.nextCursor, total: page.total };
    }),

    create: connections.create.handler(async ({ input, errors }) => {
      const created = await connectionService.create(input);
      if (created.isErr()) {
        throw toApiError(errors, created.error);
      }

      return redact(created.value);
    }),

    get: connections.get.handler(async ({ input, errors }) => {
      const connection = await connectionService.get(input.key);
      if (connection.isErr()) {
        throw toApiError(errors, connection.error);
      }

      return redact(connection.value);
    }),

    usages: connections.usages.handler(async ({ input }) => {
      const { jobs, groups } = await connectionService.usages(input.key);
      const endpoints = (refs: readonly ConnectionRef[]) =>
        refs.flatMap((ref) =>
          ref.key === input.key && ref.endpoint !== undefined ? [ref.endpoint] : [],
        );

      return {
        jobs: jobs.map((job) => ({
          id: job.id,
          name: job.name,
          enabled: job.enabled,
          endpoints: endpoints(job.connectionRefs),
        })),
        groups: groups.map((group) => ({
          id: group.id,
          name: group.name,
          endpoints: endpoints(group.connectionRefs),
        })),
      };
    }),

    update: connections.update.handler(async ({ input, errors }) => {
      const { expectedVersion, ...spec } = input;
      const previous = await connectionService.get(spec.key);
      if (previous.isErr()) {
        throw toApiError(errors, previous.error);
      }
      const updated = await connectionService.update(
        spec.key,
        redactor.restoreConnection(spec, previous.value),
        expectedVersion,
      );
      if (updated.isErr()) {
        throw toApiError(errors, updated.error);
      }

      return redact(updated.value);
    }),

    delete: connections.delete.handler(async ({ input, errors }) => {
      const deleted = await connectionService.delete(input.key);
      if (deleted.isErr()) {
        throw toApiError(errors, deleted.error);
      }

      return { deleted: true };
    }),
  };
};

export class ConnectionsRouter {
  constructor(readonly handlers: ReturnType<typeof connectionsHandlers>) {}
}
