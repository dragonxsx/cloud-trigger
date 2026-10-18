import { contract } from '@cloud-trigger/api-contract';
import { Controller, Inject } from '@nestjs/common';
import { Implement } from '@orpc/nest';

import type { AppContext } from '../app-context.js';
import { APP_CONTEXT } from '../tokens.js';
import { type Api, createApi, toApiError } from './api.js';
import { JobRedactor } from './redaction.js';

@Controller()
export class RunsController {
  readonly #api: Api;
  readonly #redactor: JobRedactor;

  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {
    this.#api = createApi(ctx);
    this.#redactor = new JobRedactor(ctx.registry);
  }

  @Implement(contract.runs)
  runs() {
    const { jobService, persistence, runEvents } = this.ctx;
    const runs = this.#api.runs;

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

        return deliveries.map((d) => this.#redactor.redactDelivery(d));
      }),

      stream: runs.stream.handler(async function* ({ input, signal }) {
        for await (const run of runEvents.subscribe('run', { signal })) {
          if (input.jobId === undefined || run.jobId === input.jobId) {
            yield run;
          }
        }
      }),
    };
  }
}
