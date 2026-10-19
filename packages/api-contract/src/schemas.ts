import {
  ApiKey,
  ApiKeyId,
  AuthMethods,
  ConfigIssue,
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
  JobSpec,
  LintIssue,
  ProviderKind,
  Run,
  RunId,
  RunReason,
  RunStatus,
  ScheduleDecision,
  SchedulePreview,
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
