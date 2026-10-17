import { contract } from '@cloud-trigger/api-contract';
import { Controller, Inject } from '@nestjs/common';
import { Implement } from '@orpc/nest';

import type { AppContext } from '../app-context.js';
import { APP_CONTEXT } from '../tokens.js';
import { type Api, createApi, toApiError } from './api.js';

@Controller()
export class RunsController {
  readonly #api: Api;

  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {
    this.#api = createApi(ctx);
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
