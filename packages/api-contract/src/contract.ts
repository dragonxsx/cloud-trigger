import {
  Connection,
  ConnectionSpec,
  Environment,
  EnvironmentSpec,
  Group,
  GroupSpec,
  Job,
  JobSpec,
  NotificationDelivery,
  PendingRun,
  Run,
  Workflow,
  WorkflowRun,
  WorkflowSpec,
} from '@cloud-trigger/core';
import { eventIterator, oc } from '@orpc/contract';
import { z } from 'zod';

import {
  AnalyticsRange,
  ApiKeyIdParam,
  ApiKeyView,
  AuthConfig,
  AuthSettingsView,
  ChangePasswordInput,
  CreateApiKeyInput,
  CreateUserInput,
  CreatedApiKey,
  DatabaseTestInput,
  DatabaseTestResult,
  LoginInput,
  OidcTestInput,
  OidcTestResult,
  ResetPasswordInput,
  SessionToken,
  SetupCompleteInput,
  SetupStatus,
  SetupTokenInput,
  UpdateAuthSettingsInput,
  UpdateUserInput,
  UserIdParam,
  UserListQuery,
  UserPage,
  UserView,
  AnalyticsSummary,
  BackfillInput,
  BackfillResult,
  ExtractConnectionInput,
  ExtractConnectionResult,
  ConfigIssue,
  ConnectionKeyParam,
  ConnectionListQuery,
  EnvironmentKeyParam,
  EnvironmentListQuery,
  EnvironmentPage,
  UpdateEnvironmentInput,
  ConnectionPage,
  ConnectionTestInput,
  ConnectionTestOutcome,
  ConnectionUsages,
  OpenApiAnalysis,
  OpenApiPreviewInput,
  UpdateConnectionInput,
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
  ApprovalInput,
  UpdateWorkflowInput,
  WorkflowIdParam,
  WorkflowListQuery,
  WorkflowPage,
  WorkflowRunIdParam,
  WorkflowRunListQuery,
  WorkflowRunPage,
} from './schemas.js';

export interface McpToolMeta {
  readonly name: string;
  readonly description?: string;
  readonly destructive?: boolean;
}

export interface ApiMeta {
  readonly minimumScope: Scope;
  readonly public?: boolean;
  readonly mcp?: McpToolMeta;
}

const readTool = (mcp: McpToolMeta): ApiMeta => ({ minimumScope: 'read', mcp });
const writeTool = (mcp: McpToolMeta): ApiMeta => ({ minimumScope: 'write', mcp });

const base = oc.$meta<ApiMeta>({ minimumScope: 'read' }).errors({
  UNAUTHORIZED: { status: 401 },
  FORBIDDEN: { status: 403 },
  NOT_FOUND: { status: 404 },
  CONFLICT: { status: 409 },
  INVALID_CONFIG: { status: 422, data: z.object({ issues: z.array(ConfigIssue) }) },
  SETUP_REQUIRED: { status: 503 },
  TOO_MANY_REQUESTS: { status: 429 },
});
const write = base.meta({ minimumScope: 'write' });
const admin = base.meta({ minimumScope: 'admin' });
const open = base.meta({ minimumScope: 'read', public: true });

const jobs = {
  list: base
    .route({ method: 'GET', path: '/jobs', summary: 'List jobs' })
    .meta(
      readTool({
        name: 'list_jobs',
        description: 'List jobs, newest first. Filter by search text, tag, group or state.',
      }),
    )
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
  get: base
    .route({ method: 'GET', path: '/jobs/{id}' })
    .meta(readTool({ name: 'get_job', description: 'Get one job, with secrets redacted.' }))
    .input(IdParam)
    .output(Job),
  create: write
    .route({ method: 'POST', path: '/jobs', successStatus: 201 })
    .meta(
      writeTool({
        name: 'create_job',
        description:
          'Create a job. Provider configs follow the JSON Schemas from GET /api/providers; reference secrets as {{secret:NAME}}. To call a saved API, set target.connection to { key, endpoint } from list_connections; target.config then only overrides the endpoint fields.',
      }),
    )
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
    .meta(writeTool({ name: 'pause_job', description: 'Pause a job so it stops scheduling runs.' }))
    .input(IdParam.extend({ reason: z.string().max(500).optional() }))
    .output(Job),
  resume: write
    .route({ method: 'POST', path: '/jobs/{id}/resume' })
    .meta(writeTool({ name: 'resume_job', description: 'Resume a paused job.' }))
    .input(IdParam)
    .output(Job),
  backfill: write
    .route({
      method: 'POST',
      path: '/jobs/{id}/backfill',
      summary: 'Enqueue runs for past fire times (idempotent per fire time)',
    })
    .input(BackfillInput)
    .output(BackfillResult),
  extractConnection: write
    .route({
      method: 'POST',
      path: '/jobs/{id}/extract-connection',
      summary: 'Move an inline target, trigger or notifier config onto a new connection',
    })
    .input(ExtractConnectionInput)
    .output(ExtractConnectionResult),
  explain: base
    .route({
      method: 'GET',
      path: '/jobs/{id}/explain',
      summary: "Why didn't it run? Recent scheduler decisions plus a narrative",
    })
    .meta(
      readTool({
        name: 'explain_job',
        description: 'Explain why a job did or did not run recently, and when it runs next.',
      }),
    )
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
    .meta(
      writeTool({
        name: 'run_job',
        description: 'Queue a run of a job now. Pass idempotencyKey to make retries safe.',
      }),
    )
    .input(IdParam.extend({ idempotencyKey: z.string().max(200).optional() }))
    .output(PendingRun),
};

const runs = {
  list: base
    .route({ method: 'GET', path: '/runs' })
    .meta(
      readTool({
        name: 'list_runs',
        description: 'List runs, newest first. Filter by job, status, reason or time range.',
      }),
    )
    .input(RunListQuery)
    .output(RunPage),
  get: base
    .route({ method: 'GET', path: '/runs/{id}' })
    .meta(readTool({ name: 'get_run', description: 'Get one run with its attempts and results.' }))
    .input(RunIdParam)
    .output(Run),
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

const connections = {
  test: write
    .route({
      method: 'POST',
      path: '/connections/test',
      summary: 'Check that a connection is reachable and its credentials work',
    })
    .input(ConnectionTestInput)
    .output(ConnectionTestOutcome),
  openapiPreview: write
    .route({
      method: 'POST',
      path: '/connections/openapi/preview',
      summary:
        'Read an OpenAPI document into endpoint drafts for an http connection; saves nothing',
    })
    .input(OpenApiPreviewInput)
    .output(OpenApiAnalysis),
  list: base
    .route({ method: 'GET', path: '/connections', summary: 'List connections by key' })
    .meta(
      readTool({
        name: 'list_connections',
        description:
          'List saved connections (base URL, credentials and named endpoints) that job targets can reference by key.',
      }),
    )
    .input(ConnectionListQuery)
    .output(ConnectionPage),
  create: write
    .route({ method: 'POST', path: '/connections', successStatus: 201 })
    .input(ConnectionSpec)
    .output(Connection),
  get: base
    .route({ method: 'GET', path: '/connections/{key}' })
    .input(ConnectionKeyParam)
    .output(Connection),
  usages: base
    .route({
      method: 'GET',
      path: '/connections/{key}/usages',
      summary: 'Jobs and groups that use a connection',
    })
    .input(ConnectionKeyParam)
    .output(ConnectionUsages),
  update: write
    .route({
      method: 'PUT',
      path: '/connections/{key}',
      summary: 'Update a connection; INVALID_CONFIG when a job using it would break',
    })
    .input(UpdateConnectionInput)
    .output(Connection),
  delete: write
    .route({
      method: 'DELETE',
      path: '/connections/{key}',
      summary: 'Delete a connection; CONFLICT while jobs use it',
    })
    .input(ConnectionKeyParam)
    .output(z.object({ deleted: z.boolean() })),
};

const environments = {
  list: base
    .route({ method: 'GET', path: '/environments', summary: 'List environments by key' })
    .input(EnvironmentListQuery)
    .output(EnvironmentPage),
  create: write
    .route({ method: 'POST', path: '/environments', successStatus: 201 })
    .input(EnvironmentSpec)
    .output(Environment),
  get: base
    .route({ method: 'GET', path: '/environments/{key}' })
    .input(EnvironmentKeyParam)
    .output(Environment),
  update: write
    .route({ method: 'PUT', path: '/environments/{key}' })
    .input(UpdateEnvironmentInput)
    .output(Environment),
  delete: write
    .route({
      method: 'DELETE',
      path: '/environments/{key}',
      summary:
        'Delete an environment; CONFLICT while a job, group, workflow or connection overlay uses it',
    })
    .input(EnvironmentKeyParam)
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
    .meta(
      readTool({
        name: 'analytics_summary',
        description: 'Run totals, success rate and p50/p95 latency for a time range.',
      }),
    )
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

const workflows = {
  list: base
    .route({ method: 'GET', path: '/workflows', summary: 'List workflows' })
    .meta(readTool({ name: 'list_workflows', description: 'List DAG workflows.' }))
    .input(WorkflowListQuery)
    .output(WorkflowPage),
  get: base
    .route({ method: 'GET', path: '/workflows/{id}' })
    .input(WorkflowIdParam)
    .output(Workflow),
  create: write
    .route({ method: 'POST', path: '/workflows', successStatus: 201 })
    .input(WorkflowSpec)
    .output(Workflow),
  update: write
    .route({ method: 'PUT', path: '/workflows/{id}' })
    .input(UpdateWorkflowInput)
    .output(Workflow),
  delete: write
    .route({ method: 'DELETE', path: '/workflows/{id}' })
    .input(WorkflowIdParam)
    .output(z.object({ deleted: z.boolean() })),
  run: write
    .route({
      method: 'POST',
      path: '/workflows/{id}/run',
      successStatus: 202,
      summary: 'Start a workflow run now',
    })
    .input(WorkflowIdParam)
    .output(WorkflowRun),
};

const workflowRuns = {
  list: base
    .route({ method: 'GET', path: '/workflow-runs' })
    .input(WorkflowRunListQuery)
    .output(WorkflowRunPage),
  get: base
    .route({ method: 'GET', path: '/workflow-runs/{id}' })
    .input(WorkflowRunIdParam)
    .output(WorkflowRun),
  approve: write
    .route({
      method: 'POST',
      path: '/workflow-runs/{id}/approve',
      summary: 'Approve a waiting approval gate',
    })
    .meta(
      writeTool({
        name: 'approve_workflow_run',
        description: 'Approve a workflow approval gate that is waiting for a decision.',
      }),
    )
    .input(ApprovalInput)
    .output(WorkflowRun),
  reject: write
    .route({
      method: 'POST',
      path: '/workflow-runs/{id}/reject',
      summary: 'Reject a waiting approval gate',
    })
    .input(ApprovalInput)
    .output(WorkflowRun),
  cancel: write
    .route({ method: 'POST', path: '/workflow-runs/{id}/cancel' })
    .input(WorkflowRunIdParam)
    .output(WorkflowRun),
};

const auth = {
  me: base.route({ method: 'GET', path: '/me' }).input(z.object({})).output(Me),
  config: open
    .route({
      method: 'GET',
      path: '/auth/config',
      summary: 'How the UI can sign in (no authentication required)',
    })
    .input(z.object({}))
    .output(AuthConfig),
  login: open
    .route({ method: 'POST', path: '/auth/login', summary: 'Sign in with a username and password' })
    .input(LoginInput)
    .output(SessionToken),
  changePassword: base
    .route({
      method: 'POST',
      path: '/auth/password',
      summary: 'Change your own password; signs out your other sessions',
    })
    .input(ChangePasswordInput)
    .output(SessionToken),
};

const setup = {
  status: open
    .route({ method: 'GET', path: '/setup/status', summary: 'Which first-run setup step is due' })
    .input(z.object({}))
    .output(SetupStatus),
  verifyToken: open
    .route({ method: 'POST', path: '/setup/verify', summary: 'Check the one-time setup token' })
    .input(SetupTokenInput)
    .output(z.object({ ok: z.literal(true) })),
  testDatabase: open
    .route({
      method: 'POST',
      path: '/setup/database/test',
      summary: 'Try a database connection and return the env vars that select it',
    })
    .input(DatabaseTestInput)
    .output(DatabaseTestResult),
  testOidc: open
    .route({
      method: 'POST',
      path: '/setup/oidc/test',
      summary: 'Fetch OpenID discovery for an issuer (setup token, or the admin scope)',
    })
    .input(OidcTestInput)
    .output(OidcTestResult),
  complete: open
    .route({
      method: 'POST',
      path: '/setup/complete',
      summary: 'Save the sign-in methods and create the first admin account',
    })
    .input(SetupCompleteInput)
    .output(SessionToken),
};

const authSettings = {
  get: admin
    .route({ method: 'GET', path: '/auth-settings' })
    .input(z.object({}))
    .output(AuthSettingsView),
  update: admin
    .route({ method: 'PUT', path: '/auth-settings' })
    .input(UpdateAuthSettingsInput)
    .output(AuthSettingsView),
  rotateSessionSecret: admin
    .route({
      method: 'POST',
      path: '/auth-settings/rotate-session-secret',
      summary: 'Sign out every password session, including yours',
    })
    .input(z.object({}))
    .output(AuthSettingsView),
};

const users = {
  list: admin.route({ method: 'GET', path: '/users' }).input(UserListQuery).output(UserPage),
  create: admin
    .route({ method: 'POST', path: '/users', successStatus: 201 })
    .input(CreateUserInput)
    .output(UserView),
  get: admin.route({ method: 'GET', path: '/users/{id}' }).input(UserIdParam).output(UserView),
  update: admin
    .route({ method: 'PUT', path: '/users/{id}' })
    .input(UpdateUserInput)
    .output(UserView),
  delete: admin
    .route({ method: 'DELETE', path: '/users/{id}' })
    .input(UserIdParam)
    .output(z.object({ deleted: z.boolean() })),
  resetPassword: admin
    .route({
      method: 'POST',
      path: '/users/{id}/password',
      summary: "Set a user's password and sign out their sessions",
    })
    .input(ResetPasswordInput)
    .output(UserView),
};

const apiKeys = {
  list: admin
    .route({ method: 'GET', path: '/api-keys' })
    .input(z.object({}))
    .output(z.array(ApiKeyView)),
  create: admin
    .route({ method: 'POST', path: '/api-keys', successStatus: 201 })
    .input(CreateApiKeyInput)
    .output(CreatedApiKey),
  revoke: admin
    .route({ method: 'DELETE', path: '/api-keys/{id}' })
    .input(ApiKeyIdParam)
    .output(z.object({ revoked: z.boolean() })),
};

export const contract = oc.prefix('/api').router({
  jobs: oc.tag('Jobs').router(jobs),
  runs: oc.tag('Runs').router(runs),
  groups: oc.tag('Groups').router(groups),
  connections: oc.tag('Connections').router(connections),
  environments: oc.tag('Environments').router(environments),
  workflows: oc.tag('Workflows').router(workflows),
  workflowRuns: oc.tag('Workflows').router(workflowRuns),
  calendar: oc.tag('Calendar').router(calendar),
  analytics: oc.tag('Analytics').router(analytics),
  providers: oc.tag('Providers').router(providers),
  auth: oc.tag('Auth').router(auth),
  setup: oc.tag('Setup').router(setup),
  authSettings: oc.tag('Access').router(authSettings),
  users: oc.tag('Access').router(users),
  apiKeys: oc.tag('Access').router(apiKeys),
});

export type Contract = typeof contract;
