import { AccessRouter } from './access/access.router.js';
import { AnalyticsRouter } from './analytics/analytics.router.js';
import { CalendarRouter } from './calendar/calendar.router.js';
import { CatalogRouter } from './catalog/catalog.router.js';
import { GroupsRouter } from './groups/groups.router.js';
import { JobsRouter } from './jobs/jobs.router.js';
import { RunsRouter } from './runs/runs.router.js';
import { SessionRouter } from './session/session.router.js';
import { SetupRouter } from './setup/setup.router.js';
import { WorkflowsRouter } from './workflows/workflows.router.js';

export const APP_ROUTER_PARTS = [
  JobsRouter,
  RunsRouter,
  GroupsRouter,
  WorkflowsRouter,
  CalendarRouter,
  AnalyticsRouter,
  CatalogRouter,
  SessionRouter,
  SetupRouter,
  AccessRouter,
] as const;

export const composeAppRouter = (
  jobs: JobsRouter,
  runs: RunsRouter,
  groups: GroupsRouter,
  workflows: WorkflowsRouter,
  calendar: CalendarRouter,
  analytics: AnalyticsRouter,
  providers: CatalogRouter,
  auth: SessionRouter,
  setup: SetupRouter,
  access: AccessRouter,
) => ({
  jobs: jobs.handlers,
  runs: runs.handlers,
  groups: groups.handlers,
  workflows: workflows.workflows,
  workflowRuns: workflows.workflowRuns,
  calendar: calendar.handlers,
  analytics: analytics.handlers,
  providers: providers.handlers,
  auth: auth.handlers,
  setup: setup.handlers,
  ...access.handlers,
});

export type AppRouter = ReturnType<typeof composeAppRouter>;

export class ApiRouter {
  constructor(readonly router: AppRouter) {}
}
