import { Job, JobSpec, PendingRun, Run } from '@cloud-trigger/core';
import { eventIterator, oc } from '@orpc/contract';
import { z } from 'zod';

import {
  AnalyticsRange,
  AnalyticsSummary,
  ConfigIssue,
  IdParam,
  JobListQuery,
  JobPage,
  Me,
  ProviderInfo,
  ProviderKind,
  RunIdParam,
  RunListQuery,
  RunPage,
  SchedulePreview,
  type Scope,
  TimeseriesPoint,
  TimeseriesQuery,
  TopError,
  TopErrorsQuery,
  UpdateJobInput,
} from './schemas.js';

export interface ApiMeta {
  readonly minimumScope: Scope;
}

const base = oc.$meta<ApiMeta>({ minimumScope: 'read' }).errors({
  UNAUTHORIZED: { status: 401 },
  FORBIDDEN: { status: 403 },
  NOT_FOUND: { status: 404 },
  CONFLICT: { status: 409 },
  INVALID_CONFIG: { status: 422, data: z.object({ issues: z.array(ConfigIssue) }) },
});
const write = base.meta({ minimumScope: 'write' });

const jobs = {
  list: base
    .route({ method: 'GET', path: '/jobs', summary: 'List jobs' })
    .input(JobListQuery)
    .output(JobPage),
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
  stream: base
    .route({ method: 'GET', path: '/stream/runs', summary: 'Server-sent events of run changes' })
    .input(z.object({ jobId: IdParam.shape.id.optional() }))
    .output(eventIterator(Run)),
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
};

export const contract = oc.prefix('/api').router({
  jobs: oc.tag('Jobs').router(jobs),
  runs: oc.tag('Runs').router(runs),
  analytics: oc.tag('Analytics').router(analytics),
  providers: oc.tag('Providers').router(providers),
  auth: oc.tag('Auth').router(auth),
});

export type Contract = typeof contract;
