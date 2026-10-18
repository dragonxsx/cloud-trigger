import type { WorkflowService } from '@cloud-trigger/engine';

import { type Api, toApiError } from '../shared/api.js';
import type { JobRedactor } from '../shared/redaction.js';

export interface WorkflowsRouterDeps {
  readonly api: Api;
  readonly workflowService: WorkflowService;
  readonly redactor: JobRedactor;
}

export const workflowsHandlers = ({ api, workflowService, redactor }: WorkflowsRouterDeps) => {
  const workflows = api.workflows;
  const redact = redactor.redactWorkflow.bind(redactor);
  const redactRun = redactor.redactWorkflowRun.bind(redactor);

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
        redactor.restoreWorkflow(spec, previous.value),
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
};

export const workflowRunsHandlers = ({ api, workflowService, redactor }: WorkflowsRouterDeps) => {
  const runs = api.workflowRuns;
  const redactRun = redactor.redactWorkflowRun.bind(redactor);

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
};

export class WorkflowsRouter {
  constructor(
    readonly workflows: ReturnType<typeof workflowsHandlers>,
    readonly workflowRuns: ReturnType<typeof workflowRunsHandlers>,
  ) {}
}
