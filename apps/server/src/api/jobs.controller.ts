import { contract } from '@cloud-trigger/api-contract';
import { Controller, Inject } from '@nestjs/common';
import { Implement } from '@orpc/nest';

import type { AppContext } from '../app-context.js';
import { APP_CONTEXT } from '../tokens.js';
import { type Api, type ErrorFactories, createApi, toApiError } from './api.js';
import { JobRedactor } from './redaction.js';

@Controller()
export class JobsController {
  readonly #api: Api;
  readonly #redactor: JobRedactor;

  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {
    this.#api = createApi(ctx);
    this.#redactor = new JobRedactor(ctx.registry);
  }

  @Implement(contract.jobs)
  jobs() {
    const { jobService, persistence } = this.ctx;
    const jobs = this.#api.jobs;
    const redact = this.#redactor.redact.bind(this.#redactor);

    const getOrThrow = async (
      id: Parameters<typeof jobService.get>[0],
      errors: Pick<ErrorFactories, 'NOT_FOUND'>,
    ) => {
      const job = await jobService.get(id);
      if (!job) {
        throw errors.NOT_FOUND({ message: `Job ${id} not found` });
      }

      return job;
    };

    return {
      list: jobs.list.handler(async ({ input }) => {
        const page = await persistence.jobs.list(input);

        return { items: page.items.map(redact), nextCursor: page.nextCursor, total: page.total };
      }),

      get: jobs.get.handler(async ({ input, errors }) =>
        redact(await getOrThrow(input.id, errors)),
      ),

      create: jobs.create.handler(async ({ input, errors }) => {
        const created = await jobService.create(input);
        if (created.isErr()) {
          throw toApiError(errors, created.error);
        }

        return redact(created.value);
      }),

      update: jobs.update.handler(async ({ input, errors }) => {
        const { id, expectedVersion, ...spec } = input;
        const previous = await getOrThrow(id, errors);
        const updated = await jobService.update(
          id,
          this.#redactor.restore(spec, previous),
          expectedVersion,
        );
        if (updated.isErr()) {
          throw toApiError(errors, updated.error);
        }

        return redact(updated.value);
      }),

      delete: jobs.delete.handler(async ({ input }) => ({
        deleted: await jobService.delete(input.id),
      })),

      validate: jobs.validate.handler(({ input, errors }) => {
        const validated = jobService.validate(input);
        if (validated.isErr()) {
          throw toApiError(errors, validated.error);
        }

        return validated.value.preview;
      }),

      pause: jobs.pause.handler(async ({ input, errors }) => {
        const paused = await jobService.pause(input.id, input.reason);
        if (paused.isErr()) {
          throw toApiError(errors, paused.error);
        }

        return redact(await getOrThrow(input.id, errors));
      }),

      resume: jobs.resume.handler(async ({ input, errors }) => {
        const resumed = await jobService.resume(input.id);
        if (resumed.isErr()) {
          throw toApiError(errors, resumed.error);
        }

        return redact(await getOrThrow(input.id, errors));
      }),

      run: jobs.run.handler(async ({ input, errors }) => {
        const run = await jobService.runNow(input.id, { idempotencyKey: input.idempotencyKey });
        if (run.isErr()) {
          throw toApiError(errors, run.error);
        }

        return run.value;
      }),
    };
  }
}
