import {
  ApiKey,
  ApiKeyId,
  AuthMethods,
  ConfigIssue,
  Connection,
  ConnectionKey,
  ConnectionSpec,
  EndpointKey,
  Environment,
  EnvironmentKey,
  EnvironmentSpec,
  ExtractSlot,
  Password,
  Scope,
  User,
  UserId,
  Username,
  Group,
  GroupId,
  GroupSpec,
  Job,
  JobId,
  JobSortField,
  JobSpec,
  LintIssue,
  OpenApiAnalysis,
  OpenApiImportOptions,
  ProviderKind,
  Run,
  RunId,
  RunReason,
  RunStatus,
  ScheduleDecision,
  SchedulePreview,
  SortOrder,
  Workflow,
  WorkflowId,
  WorkflowRun,
  WorkflowRunId,
  WorkflowRunStatus,
  WorkflowSpec,
} from '@cloud-trigger/core';
import { z } from 'zod';

export { AuthMethods, ConfigIssue, LintIssue, ProviderKind, SchedulePreview, Scope };

export const QueryDate = z.iso.datetime({ offset: true }).transform((s) => new Date(s));

const commaSeparated = <T extends z.ZodType>(item: T) =>
  z.preprocess((v) => (typeof v === 'string' ? v.split(',') : v), z.array(item));

export const PageQuery = z.object({
  limit: z.int().min(1).max(200).default(50),
  cursor: z.string().optional(),
  offset: z.int().min(0).optional(),
});

const page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable(), total: z.int().min(0) });

export const JobPage = page(Job);
export const RunPage = page(Run);

export const IdParam = z.object({ id: JobId });
export const BackfillInput = z.object({
  id: JobId,
  from: QueryDate.describe('First fire time to include (inclusive).'),
  to: QueryDate.describe('Last fire time to include (inclusive).'),
  maxRuns: z.int().min(1).max(1_000).default(100),
  dryRun: z.boolean().default(false).describe('Return the fire times without inserting runs.'),
});
export const BackfillResult = z.object({
  fireTimes: z.array(z.date()),
  created: z.array(RunId),
  duplicates: z.int().min(0).describe('Fire times already backfilled earlier; not inserted again.'),
  truncated: z.boolean().describe('More fire times exist in the range than maxRuns.'),
});
export const ExtractConnectionInput = z.object({
  id: JobId,
  slot: ExtractSlot.describe('The inline config to move onto a new connection.'),
  key: ConnectionKey.optional().describe(
    'Key of the new connection; derived from the host when unset.',
  ),
  name: z.string().trim().max(200).optional(),
  endpoint: EndpointKey.optional().describe(
    'Key of the endpoint; derived from the job name when unset.',
  ),
  baseUrl: z
    .string()
    .regex(/^https?:\/\//, 'Must start with http:// or https://')
    .optional()
    .describe('HTTP connections only: a prefix of the URL to keep on the connection.'),
  expectedVersion: z.int().min(1),
  dryRun: z.boolean().default(true).describe('Return the draft without saving anything.'),
});
export const ExtractConnectionResult = z.object({
  dryRun: z.boolean(),
  connection: Connection,
  endpoint: EndpointKey,
  job: Job,
  similar: z
    .array(
      z.object({
        key: ConnectionKey,
        name: z.string(),
        match: z.enum(['identical', 'same_address']),
      }),
    )
    .describe('Existing connections the job could use instead.'),
  warnings: z.array(ConfigIssue),
});
export const ExplainQuery = z.object({
  id: JobId,
  at: QueryDate.optional().describe('Explain as of this time; defaults to now.'),
});
export const Explanation = z.object({
  narrative: z.array(z.string()),
  nextFireAt: z.date().nullable(),
  decisions: z.array(ScheduleDecision),
});
export const ExportQuery = z.object({ tag: z.string().optional(), groupId: GroupId.optional() });
export const ImportInput = z.object({
  yaml: z.string().max(5_000_000).describe('One job per YAML document, as produced by the export.'),
  mode: z
    .enum(['upsert', 'replace'])
    .default('upsert')
    .describe('replace also deletes jobs that are not in the file.'),
  dryRun: z.boolean().default(true),
});
export const ImportResult = z.object({
  dryRun: z.boolean(),
  created: z.array(z.string()),
  updated: z.array(z.string()),
  unchanged: z.array(z.string()),
  deleted: z.array(z.string()),
  issues: z.array(
    z.object({
      document: z.int().min(0),
      name: z.string().nullable(),
      path: z.string(),
      message: z.string(),
    }),
  ),
});
export const JobSummary = Job.pick({ id: true, name: true, enabled: true, pausedReason: true });
export const JobDependencies = z.object({
  upstream: z.array(JobSummary),
  downstream: z.array(JobSummary),
});
export const GroupIdParam = z.object({ id: GroupId });
export const GroupPage = page(Group);
export const GroupListQuery = PageQuery.extend({ search: z.string().optional() });
export const UpdateGroupInput = GroupSpec.extend({ id: GroupId, expectedVersion: z.int().min(1) });
export const RunIdParam = z.object({ id: RunId });

export const JobListQuery = PageQuery.extend({
  search: z.string().optional(),
  tag: z.string().optional(),
  groupId: GroupId.optional(),
  enabled: z.boolean().optional(),
  slaBreached: z.boolean().optional(),
  environment: EnvironmentKey.optional().describe('Jobs that set this environment themselves.'),
  sort: JobSortField.optional().describe(
    'Order the whole result by this field instead of newest first. Nulls sort last, ties newest first; page with offset.',
  ),
  order: SortOrder.default('asc').describe('Direction for sort.'),
}).refine((q) => q.sort === undefined || q.cursor === undefined, {
  message: 'cursor pages newest first only; page a sorted list with offset',
  path: ['cursor'],
});

export const UpdateJobInput = JobSpec.extend({ id: JobId, expectedVersion: z.int().min(1) });

export const RunListQuery = PageQuery.extend({
  jobId: JobId.optional(),
  status: commaSeparated(RunStatus).optional(),
  reason: RunReason.optional(),
  from: QueryDate.optional(),
  to: QueryDate.optional(),
  late: z.boolean().optional(),
  acknowledged: z
    .boolean()
    .optional()
    .describe('With status=failed,timed_out and false, lists the failed-runs inbox.'),
});

export const RunIdsInput = z.object({ ids: z.array(RunId).min(1).max(100) });
export const BulkReplayResult = z.object({
  results: z.array(
    z.object({ runId: RunId, newRunId: RunId.nullable(), error: z.string().nullable() }),
  ),
});

export const ProviderInfo = z.object({
  kind: ProviderKind,
  type: z.string(),
  displayName: z.string(),
  description: z.string(),
  configSchema: z.record(z.string(), z.unknown()),
  connectionType: z
    .string()
    .optional()
    .describe('For targets, event sources and notifiers: the connection type they can run over.'),
  connectionFields: z
    .array(z.string())
    .optional()
    .describe(
      'For targets, event sources and notifiers: fields the connection owns. Omit them when a connection is set.',
    ),
  extractsConnection: z
    .boolean()
    .default(false)
    .describe('An inline config of this provider can be extracted into a new connection.'),
});

export const ConnectionKeyParam = z.object({ key: ConnectionKey });
export const ConnectionPage = page(Connection);
export const ConnectionListQuery = PageQuery.extend({
  search: z.string().optional(),
  type: z.string().optional(),
});
export const UpdateConnectionInput = ConnectionSpec.extend({ expectedVersion: z.int().min(1) });
export const ConnectionTestInput = z.object({
  type: z.string().min(1),
  config: z.unknown(),
  key: ConnectionKey.optional().describe(
    'Saved connection whose stored secrets replace *** values in config.',
  ),
  overlay: z
    .object({ environment: EnvironmentKey, config: z.unknown() })
    .optional()
    .describe(
      "Tests the config with this environment's merge patch applied; *** values come from the saved overlay.",
    ),
});

export const OpenApiPreviewInput = OpenApiImportOptions.extend({
  source: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('text'), text: z.string().min(1).max(5_000_000) }),
      z.object({
        kind: z.literal('url'),
        url: z
          .url({ protocol: /^https?$/ })
          .describe('Fetched by the server from public addresses only.'),
      }),
    ])
    .describe('An OpenAPI 2.0 to 3.2 document as JSON or YAML, pasted or by URL.'),
});
export { OpenApiAnalysis };

export const EnvironmentKeyParam = z.object({ key: EnvironmentKey });
export const EnvironmentPage = page(Environment);
export const EnvironmentListQuery = PageQuery.extend({ search: z.string().optional() });
export const UpdateEnvironmentInput = EnvironmentSpec.extend({ expectedVersion: z.int().min(1) });
export const ConnectionTestOutcome = z.object({ ok: z.boolean(), message: z.string() });
export const ConnectionUsage = z.object({
  id: JobId,
  name: z.string(),
  enabled: z.boolean(),
  endpoints: z
    .array(EndpointKey)
    .describe('Endpoints the job uses; empty for the base connection.'),
});
export const GroupConnectionUsage = z.object({
  id: GroupId,
  name: z.string(),
  endpoints: z
    .array(EndpointKey)
    .describe('Endpoints the default notifications use; empty for the base connection.'),
});
export const ConnectionUsages = z.object({
  jobs: z.array(ConnectionUsage),
  groups: z.array(GroupConnectionUsage),
});

export const AnalyticsRange = z.object({
  from: QueryDate,
  to: QueryDate,
  jobId: JobId.optional(),
});

const StatusCounts = z.partialRecord(RunStatus, z.number());

export const AnalyticsSummary = z.object({
  total: z.number(),
  late: z.number().describe('Finished runs flagged late by the SLA monitor.'),
  byStatus: StatusCounts,
  successRate: z.number().nullable(),
  p50Ms: z.number().nullable(),
  p95Ms: z.number().nullable(),
  avgMs: z.number().nullable(),
});

export const TimeseriesQuery = AnalyticsRange.extend({
  bucket: z.enum(['minute', 'hour', 'day']).default('hour'),
});
export const TimeseriesPoint = z.object({
  bucket: z.date(),
  byStatus: StatusCounts,
  p95Ms: z.number().nullable(),
});
export const TopErrorsQuery = AnalyticsRange.extend({ limit: z.int().min(1).max(50).default(10) });
export const TopError = z.object({ errorCode: z.string(), jobId: JobId, count: z.number() });

export const AuthConfig = z.object({
  setupRequired: z.boolean().describe('True until the first-run wizard has been completed.'),
  local: z.boolean().describe('Whether username and password sign-in is available.'),
  oidc: z
    .object({ authority: z.url(), clientId: z.string(), scope: z.string() })
    .nullable()
    .describe('Set when the UI can sign in with OpenID Connect (authorization code + PKCE).'),
  apiKeys: z.boolean().describe('Whether API-key sign-in is available.'),
  anonymous: z.boolean().describe('Whether unauthenticated visitors get read access.'),
});

export const Me = z.object({
  subject: z.string(),
  name: z.string(),
  via: z.enum(['local', 'oidc', 'api_key', 'anonymous']),
  scopes: z.array(Scope),
});

export const LoginInput = z.object({ username: z.string().min(1), password: z.string().min(1) });
export const SessionToken = z.object({ token: z.string(), expiresAt: z.date() });
export const ChangePasswordInput = z.object({
  currentPassword: z.string().min(1),
  newPassword: Password,
});

export const DatabaseDriver = z.enum(['mongo', 'postgres', 'sqlite']);
export const SetupStage = z.enum(['database', 'auth', 'done']);
export const SetupStatus = z.object({
  stage: SetupStage,
  database: z.object({
    driver: DatabaseDriver.nullable(),
    issues: z.array(ConfigIssue).describe('Why the configured database cannot be used, if so.'),
  }),
});

const SetupToken = z.string().min(1).describe('The one-time setup token from the server log.');
export const SetupTokenInput = z.object({ token: SetupToken });

export const DatabaseSettings = z.discriminatedUnion('driver', [
  z.object({
    driver: z.literal('mongo'),
    uri: z.string().min(1).meta({ title: 'Connection string' }),
    database: z.string().min(1).default('cloud_trigger'),
  }),
  z.object({ driver: z.literal('postgres'), url: z.string().min(1) }),
  z.object({
    driver: z.literal('sqlite'),
    path: z.string().min(1).default('./data/cloud-trigger.db'),
  }),
]);
export const DatabaseTestInput = z.object({ token: SetupToken, database: DatabaseSettings });
export const DatabaseTestResult = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  env: z
    .record(z.string(), z.string())
    .describe('Environment variables that select this database.'),
});

export const OidcTestInput = z.object({ token: SetupToken.optional(), issuer: z.url() });
export const OidcTestResult = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  jwksUri: z.string().nullable(),
});

export const SetupCompleteInput = z.object({
  token: SetupToken,
  admin: z.object({ username: Username, password: Password }),
  methods: AuthMethods,
});

export const AuthSettingsView = AuthMethods.extend({
  version: z.int().min(1),
  updatedAt: z.date(),
});
export const UpdateAuthSettingsInput = AuthMethods.extend({ expectedVersion: z.int().min(1) });

export const UserView = User.omit({ passwordHash: true, tokenVersion: true });
export const UserPage = page(UserView);
export const UserIdParam = z.object({ id: UserId });
export const UserListQuery = PageQuery.extend({ search: z.string().optional() });
export const CreateUserInput = z.object({
  username: Username,
  password: Password,
  scopes: z.array(Scope).min(1),
});
export const UpdateUserInput = z.object({
  id: UserId,
  expectedVersion: z.int().min(1),
  scopes: z.array(Scope).min(1),
  disabled: z.boolean(),
});
export const ResetPasswordInput = z.object({ id: UserId, password: Password });

export const ApiKeyView = ApiKey.omit({ hash: true });
export const ApiKeyIdParam = z.object({ id: ApiKeyId });
export const CreateApiKeyInput = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(Scope).min(1),
});
export const CreatedApiKey = ApiKeyView.extend({
  key: z.string().describe('The key itself. It is shown only once.'),
});

export const WorkflowIdParam = z.object({ id: WorkflowId });
export const WorkflowPage = page(Workflow);
export const WorkflowListQuery = PageQuery.extend({ search: z.string().optional() });
export const UpdateWorkflowInput = WorkflowSpec.extend({
  id: WorkflowId,
  expectedVersion: z.int().min(1),
});
export const WorkflowRunIdParam = z.object({ id: WorkflowRunId });
export const WorkflowRunPage = page(WorkflowRun);
export const WorkflowRunListQuery = PageQuery.extend({
  workflowId: WorkflowId.optional(),
  status: commaSeparated(WorkflowRunStatus).optional(),
});
export const ApprovalInput = z.object({
  id: WorkflowRunId,
  node: z.string().min(1).describe('Key of the approval node.'),
  reason: z.string().max(500).optional(),
});
