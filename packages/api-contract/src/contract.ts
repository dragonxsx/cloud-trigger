import {
  Group,
  GroupSpec,
  Job,
  JobSpec,
  NotificationDelivery,
  PendingRun,
  Run,
} from '@cloud-trigger/core';
import { eventIterator, oc } from '@orpc/contract';
import { z } from 'zod';

import {
  AnalyticsRange,
  AuthConfig,
  AnalyticsSummary,
  BackfillInput,
  BackfillResult,
  ConfigIssue,
  ExplainQuery,
  ExportQuery,
  ImportInput,
  ImportResult,
  Explanation,
  GroupIdParam,
  GroupListQuery,
  GroupPage,
  IdParam,
  JobDependencies,
  JobListQuery,
  JobPage,
  Me,
  ProviderInfo,
  ProviderKind,
  BulkReplayResult,
  RunIdParam,
  RunIdsInput,
  RunListQuery,
  RunPage,
  SchedulePreview,
  type Scope,
  TimeseriesPoint,
  TimeseriesQuery,
  TopError,
  TopErrorsQuery,
  UpdateGroupInput,
  UpdateJobInput,
} from './schemas.js';

export interface ApiMeta {
  readonly minimumScope: Scope;
  readonly public?: boolean;
}

const base = oc.$meta<ApiMeta>({ minimumScope: 'read' }).errors({
  UNAUTHORIZED: { status: 401 },
  FORBIDDEN: { status: 403 },
  NOT_FOUND: { status: 404 },
  CONFLICT: { status: 409 },
  INVALID_CONFIG: { status: 422, data: z.object({ issues: z.array(ConfigIssue) }) },
});
const write = base.meta({ minimumScope: 'write' });
const admin = base.meta({ minimumScope: 'admin' });

const jobs = {
  list: base
    .route({ method: 'GET', path: '/jobs', summary: 'List jobs' })
    .input(JobListQuery)
    .output(JobPage),
  export: admin
    .route({
      method: 'GET',
      path: '/jobs/export',
      summary: 'Export jobs as YAML (secrets redacted), keyed by name',
    })
    .input(ExportQuery)
    .output(z.file().mime(['application/yaml'])),
  import: admin
    .route({
      method: 'POST',
      path: '/jobs/import',
      summary: 'Import jobs from YAML; nothing is written if any document has issues',
    })
    .input(ImportInput)
    .output(ImportResult),
  get: base.route({ method: 'GET', path: '/jobs/{id}' }).input(IdParam).output(Job),
  create: write
    .route({ method: 'POST', path: '/jobs', successStatus: 201 })
    .input(JobSpec)
    .output(Job),
  update: write.route({ method: 'PUT', path: '/jobs/{id}' }).input(UpdateJobInput).output(Job),
  delete: write
    .route({ method: 'DELETE', path: '/jobs/{id}' })
    .input(IdParam)
    .output(z.object({ deleted: z.boolean() })),
  validate: base
    .route({
      method: 'POST',
      path: '/jobs/validate',
      summary: 'Validate a job spec and preview its schedule',
    })
    .input(JobSpec)
    .output(SchedulePreview),
  pause: write
    .route({ method: 'POST', path: '/jobs/{id}/pause' })
    .input(IdParam.extend({ reason: z.string().max(500).optional() }))
    .output(Job),
  resume: write.route({ method: 'POST', path: '/jobs/{id}/resume' }).input(IdParam).output(Job),
  backfill: write
    .route({
      method: 'POST',
      path: '/jobs/{id}/backfill',
      summary: 'Enqueue runs for past fire times (idempotent per fire time)',
    })
    .input(BackfillInput)
    .output(BackfillResult),
  explain: base
    .route({
      method: 'GET',
      path: '/jobs/{id}/explain',
      summary: "Why didn't it run? Recent scheduler decisions plus a narrative",
    })
    .input(ExplainQuery)
    .output(Explanation),
  dependencies: base
    .route({
      method: 'GET',
      path: '/jobs/{id}/dependencies',
      summary: 'Jobs this job runs after, and jobs that run after it',
    })
    .input(IdParam)
    .output(JobDependencies),
  run: write
    .route({
      method: 'POST',
      path: '/jobs/{id}/run',
      summary: 'Trigger a run now',
      successStatus: 202,
    })
    .input(IdParam.extend({ idempotencyKey: z.string().max(200).optional() }))
    .output(PendingRun),
};

const runs = {
  list: base.route({ method: 'GET', path: '/runs' }).input(RunListQuery).output(RunPage),
  get: base.route({ method: 'GET', path: '/runs/{id}' }).input(RunIdParam).output(Run),
  cancel: write.route({ method: 'POST', path: '/runs/{id}/cancel' }).input(RunIdParam).output(Run),
  replay: write
    .route({ method: 'POST', path: '/runs/{id}/replay', successStatus: 202 })
    .input(RunIdParam)
    .output(PendingRun),
  replayMany: write
    .route({
      method: 'POST',
      path: '/runs/replay',
      summary: 'Replay up to 100 finished runs',
      successStatus: 202,
    })
    .input(RunIdsInput)
    .output(BulkReplayResult),
  acknowledge: write
    .route({
      method: 'POST',
      path: '/runs/acknowledge',
      summary: 'Dismiss failed runs from the failed-runs inbox',
    })
    .input(RunIdsInput)
    .output(z.object({ acknowledged: z.int().min(0) })),
  notifications: base
    .route({
      method: 'GET',
      path: '/runs/{id}/notifications',
      summary: 'Notification deliveries for a run',
    })
    .input(RunIdParam)
    .output(z.array(NotificationDelivery)),
  stream: base
    .route({ method: 'GET', path: '/stream/runs', summary: 'Server-sent events of run changes' })
    .input(z.object({ jobId: IdParam.shape.id.optional() }))
    .output(eventIterator(Run)),
};

const groups = {
  list: base
    .route({ method: 'GET', path: '/groups', summary: 'List groups' })
    .input(GroupListQuery)
    .output(GroupPage),
  get: base.route({ method: 'GET', path: '/groups/{id}' }).input(GroupIdParam).output(Group),
  create: write
    .route({ method: 'POST', path: '/groups', successStatus: 201 })
    .input(GroupSpec)
    .output(Group),
  update: write
    .route({ method: 'PUT', path: '/groups/{id}' })
    .input(UpdateGroupInput)
    .output(Group),
  delete: write
    .route({
      method: 'DELETE',
      path: '/groups/{id}',
      summary: 'Delete a group; CONFLICT while it still has jobs',
    })
    .input(GroupIdParam)
    .output(z.object({ deleted: z.boolean() })),
};

const calendar = {
  token: base
    .route({
      method: 'POST',
      path: '/calendar/token',
      summary: 'Issue a token for subscribing to /calendar.ics from a calendar app',
    })
    .input(z.object({}))
    .output(z.object({ token: z.string(), url: z.string() })),
};

const analytics = {
  summary: base
    .route({ method: 'GET', path: '/analytics/summary' })
    .input(AnalyticsRange)
    .output(AnalyticsSummary),
  timeseries: base
    .route({ method: 'GET', path: '/analytics/timeseries' })
    .input(TimeseriesQuery)
    .output(z.array(TimeseriesPoint)),
  topErrors: base
    .route({ method: 'GET', path: '/analytics/top-errors' })
    .input(TopErrorsQuery)
    .output(z.array(TopError)),
};

const providers = {
  list: base
    .route({ method: 'GET', path: '/providers' })
    .input(z.object({ kind: ProviderKind.optional() }))
    .output(z.array(ProviderInfo)),
};

const auth = {
  me: base.route({ method: 'GET', path: '/me' }).input(z.object({})).output(Me),
  config: base
    .meta({ minimumScope: 'read', public: true })
    .route({
      method: 'GET',
      path: '/auth/config',
      summary: 'How the UI can sign in (no authentication required)',
    })
    .input(z.object({}))
    .output(AuthConfig),
};

export const contract = oc.prefix('/api').router({
  jobs: oc.tag('Jobs').router(jobs),
  runs: oc.tag('Runs').router(runs),
  groups: oc.tag('Groups').router(groups),
  calendar: oc.tag('Calendar').router(calendar),
  analytics: oc.tag('Analytics').router(analytics),
  providers: oc.tag('Providers').router(providers),
  auth: oc.tag('Auth').router(auth),
});

export type Contract = typeof contract;
