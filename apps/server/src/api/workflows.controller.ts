import { contract } from '@cloud-trigger/api-contract';
import { Controller, Inject } from '@nestjs/common';
import { Implement } from '@orpc/nest';

import type { AppContext } from '../app-context.js';
import { APP_CONTEXT } from '../tokens.js';
import { type Api, createApi, toApiError } from './api.js';
import { JobRedactor } from './redaction.js';

@Controller()
export class WorkflowsController {
  readonly #api: Api;
  readonly #redactor: JobRedactor;

  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {
    this.#api = createApi(ctx);
    this.#redactor = new JobRedactor(ctx.registry);
  }

  @Implement(contract.workflows)
  workflows() {
    const { workflowService } = this.ctx;
    const workflows = this.#api.workflows;
    const redact = this.#redactor.redactWorkflow.bind(this.#redactor);
    const redactRun = this.#redactor.redactWorkflowRun.bind(this.#redactor);

    return {
      list: workflows.list.handler(async ({ input }) => {
        const page = await workflowService.list(input);

        return { items: page.items.map(redact), nextCursor: page.nextCursor, total: page.total };
      }),

      get: workflows.get.handler(async ({ input, errors }) => {
        const found = await workflowService.get(input.id);
        if (found.isErr()) {
          throw toApiError(errors, found.error);
        }

        return redact(found.value);
      }),

      create: workflows.create.handler(async ({ input, errors }) => {
        const created = await workflowService.create(input);
        if (created.isErr()) {
          throw toApiError(errors, created.error);
        }

        return redact(created.value);
      }),

      update: workflows.update.handler(async ({ input, errors }) => {
        const { id, expectedVersion, ...spec } = input;
        const previous = await workflowService.get(id);
        if (previous.isErr()) {
          throw toApiError(errors, previous.error);
        }
        const updated = await workflowService.update(
          id,
          this.#redactor.restoreWorkflow(spec, previous.value),
          expectedVersion,
        );
        if (updated.isErr()) {
          throw toApiError(errors, updated.error);
        }

        return redact(updated.value);
      }),

      delete: workflows.delete.handler(async ({ input }) => ({
        deleted: await workflowService.delete(input.id),
      })),

      run: workflows.run.handler(async ({ input, errors }) => {
        const started = await workflowService.start(input.id);
        if (started.isErr()) {
          throw toApiError(errors, started.error);
        }

        return redactRun(started.value);
      }),
    };
  }

  @Implement(contract.workflowRuns)
  workflowRuns() {
    const { workflowService } = this.ctx;
    const runs = this.#api.workflowRuns;
    const redactRun = this.#redactor.redactWorkflowRun.bind(this.#redactor);

    return {
      list: runs.list.handler(async ({ input }) => {
        const page = await workflowService.listRuns(input);

        return { items: page.items.map(redactRun), nextCursor: page.nextCursor, total: page.total };
      }),

      get: runs.get.handler(async ({ input, errors }) => {
        const found = await workflowService.getRun(input.id);
        if (found.isErr()) {
          throw toApiError(errors, found.error);
        }

        return redactRun(found.value);
      }),

      approve: runs.approve.handler(async ({ input, errors, context }) => {
        const decided = await workflowService.decide(input.id, input.node, {
          approved: true,
          by: context.principal.subject,
          reason: input.reason,
        });
        if (decided.isErr()) {
          throw toApiError(errors, decided.error);
        }

        return redactRun(decided.value);
      }),

      reject: runs.reject.handler(async ({ input, errors, context }) => {
        const decided = await workflowService.decide(input.id, input.node, {
          approved: false,
          by: context.principal.subject,
          reason: input.reason,
        });
        if (decided.isErr()) {
          throw toApiError(errors, decided.error);
        }

        return redactRun(decided.value);
      }),

      cancel: runs.cancel.handler(async ({ input, errors }) => {
        const cancelled = await workflowService.cancel(input.id);
        if (cancelled.isErr()) {
          throw toApiError(errors, cancelled.error);
        }

        return redactRun(cancelled.value);
      }),
    };
  }
}
