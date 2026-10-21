import type { Persistence } from '@cloud-trigger/core';
import type { ConnectionExtractor, JobService, JobTransfer } from '@cloud-trigger/engine';

import { type Api, type ErrorFactories, toApiError } from '../shared/api.js';
import type { JobRedactor } from '../shared/redaction.js';
import { fromYaml, toYaml } from './transfer.js';

export interface JobsRouterDeps {
  readonly api: Api;
  readonly persistence: Persistence;
  readonly jobService: JobService;
  readonly jobTransfer: JobTransfer;
  readonly connectionExtractor: ConnectionExtractor;
  readonly redactor: JobRedactor;
}

export const jobsHandlers = ({
  api,
  persistence,
  jobService,
  jobTransfer,
  connectionExtractor,
  redactor,
}: JobsRouterDeps) => {
  const jobs = api.jobs;
  const redact = redactor.redact.bind(redactor);

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

    get: jobs.get.handler(async ({ input, errors }) => redact(await getOrThrow(input.id, errors))),

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
        redactor.restore(spec, previous),
        expectedVersion,
      );
      if (updated.isErr()) {
        throw toApiError(errors, updated.error);
      }

      return redact(updated.value);
    }),

    backfill: jobs.backfill.handler(async ({ input, errors }) => {
      const { id, ...range } = input;
      const result = await jobService.backfill(id, range);
      if (result.isErr()) {
        throw toApiError(errors, result.error);
      }

      return {
        ...result.value,
        fireTimes: [...result.value.fireTimes],
        created: [...result.value.created],
      };
    }),

    extractConnection: jobs.extractConnection.handler(async ({ input, errors }) => {
      const result = await connectionExtractor.extract(input);
      if (result.isErr()) {
        throw toApiError(errors, result.error);
      }
      const { connection, job, similar, warnings } = result.value;

      return {
        ...result.value,
        connection: redactor.redactConnection(connection),
        job: redact(job),
        similar: [...similar],
        warnings: [...warnings],
      };
    }),

    export: jobs.export.handler(async ({ input }) => {
      const docs = await jobTransfer.export(input, redact);

      return new File([toYaml(docs)], 'jobs.yaml', { type: 'application/yaml' });
    }),

    import: jobs.import.handler(async ({ input }) => {
      const parsed = fromYaml(input.yaml);
      if (parsed.issues.length > 0) {
        return {
          dryRun: input.dryRun,
          created: [],
          updated: [],
          unchanged: [],
          deleted: [],
          issues: parsed.issues,
        };
      }
      const result = await jobTransfer.import(parsed.values, {
        mode: input.mode,
        dryRun: input.dryRun,
        restore: (next, previous) => redactor.restore(next, previous),
      });

      return {
        dryRun: result.dryRun,
        created: [...result.created],
        updated: [...result.updated],
        unchanged: [...result.unchanged],
        deleted: [...result.deleted],
        issues: [...result.issues],
      };
    }),

    explain: jobs.explain.handler(async ({ input, errors }) => {
      const result = await jobService.explain(input.id, input.at);
      if (result.isErr()) {
        throw toApiError(errors, result.error);
      }
      const { narrative, nextFireAt, decisions } = result.value;

      return { narrative: [...narrative], nextFireAt, decisions: [...decisions] };
    }),

    dependencies: jobs.dependencies.handler(async ({ input, errors }) => {
      await getOrThrow(input.id, errors);
      const summary = (job: {
        id: typeof input.id;
        name: string;
        enabled: boolean;
        pausedReason: string | null;
      }) => ({
        id: job.id,
        name: job.name,
        enabled: job.enabled,
        pausedReason: job.pausedReason,
      });
      const { upstream, downstream } = await jobService.dependencies(input.id);

      return { upstream: upstream.map(summary), downstream: downstream.map(summary) };
    }),

    delete: jobs.delete.handler(async ({ input, errors }) => {
      const deleted = await jobService.delete(input.id);
      if (deleted.isErr()) {
        throw toApiError(errors, deleted.error);
      }

      return { deleted: deleted.value };
    }),

    validate: jobs.validate.handler(async ({ input, errors }) => {
      const validated = await jobService.validate(input);
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
};

export class JobsRouter {
  constructor(readonly handlers: ReturnType<typeof jobsHandlers>) {}
}
