import type { Persistence } from '@cloud-trigger/core';
import type { JobService } from '@cloud-trigger/engine';

import { type Api, toApiError } from '../shared/api.js';
import type { JobRedactor } from '../shared/redaction.js';
import type { RunEvents } from './run-events.js';

export interface RunsRouterDeps {
  readonly api: Api;
  readonly persistence: Persistence;
  readonly jobService: JobService;
  readonly runEvents: RunEvents;
  readonly redactor: JobRedactor;
}

export const runsHandlers = ({
  api,
  persistence,
  jobService,
  runEvents,
  redactor,
}: RunsRouterDeps) => {
  const runs = api.runs;

  return {
    list: runs.list.handler(async ({ input }) => {
      const page = await persistence.runs.list(input);

      return { items: [...page.items], nextCursor: page.nextCursor, total: page.total };
    }),

    get: runs.get.handler(async ({ input, errors }) => {
      const run = await persistence.runs.get(input.id);
      if (!run) {
        throw errors.NOT_FOUND({ message: `Run ${input.id} not found` });
      }

      return run;
    }),

    cancel: runs.cancel.handler(async ({ input, errors }) => {
      const result = await jobService.cancelRun(input.id);
      if (result.isErr()) {
        throw toApiError(errors, result.error);
      }

      return result.value;
    }),

    replay: runs.replay.handler(async ({ input, errors }) => {
      const result = await jobService.replay(input.id);
      if (result.isErr()) {
        throw toApiError(errors, result.error);
      }

      return result.value;
    }),

    replayMany: runs.replayMany.handler(async ({ input }) => ({
      results: await jobService.replayMany(input.ids),
    })),

    acknowledge: runs.acknowledge.handler(async ({ input }) => ({
      acknowledged: await jobService.acknowledge(input.ids),
    })),

    notifications: runs.notifications.handler(async ({ input }) => {
      const deliveries = await persistence.outbox.listByRun(input.id);

      return deliveries.map((d) => redactor.redactDelivery(d));
    }),

    stream: runs.stream.handler(async function* ({ input, signal }) {
      for await (const run of runEvents.subscribe('run', { signal })) {
        if (input.jobId === undefined || run.jobId === input.jobId) {
          yield run;
        }
      }
    }),
  };
};

export class RunsRouter {
  constructor(readonly handlers: ReturnType<typeof runsHandlers>) {}
}
