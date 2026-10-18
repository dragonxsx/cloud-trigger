import { CalendarController } from '../api/calendar.controller.js';
import { GroupsController } from '../api/groups.controller.js';
import { JobsController } from '../api/jobs.controller.js';
import {
  AnalyticsController,
  AuthController,
  ProvidersController,
} from '../api/misc.controller.js';
import { RunsController } from '../api/runs.controller.js';
import { WorkflowsController } from '../api/workflows.controller.js';
import type { AppContext } from '../app-context.js';

export const appRouter = (ctx: AppContext) => {
  const workflows = new WorkflowsController(ctx);

  return {
    jobs: new JobsController(ctx).jobs(),
    runs: new RunsController(ctx).runs(),
    groups: new GroupsController(ctx).groups(),
    workflows: workflows.workflows(),
    workflowRuns: workflows.workflowRuns(),
    calendar: new CalendarController(ctx).calendar(),
    analytics: new AnalyticsController(ctx).analytics(),
    providers: new ProvidersController(ctx).providers(),
    auth: new AuthController(ctx).auth(),
  };
};

export type AppRouter = ReturnType<typeof appRouter>;
