import {
  ConfigIssue,
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
} from '@cloud-trigger/core';
import { z } from 'zod';

export { ConfigIssue, LintIssue, ProviderKind, SchedulePreview };

export const Scope = z.enum(['read', 'write', 'admin']);
export type Scope = z.output<typeof Scope>;

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
  oidc: z
    .object({ authority: z.url(), clientId: z.string(), scope: z.string() })
    .nullable()
    .describe('Set when the UI can sign in with OpenID Connect (authorization code + PKCE).'),
  apiKeys: z.boolean().describe('Whether API-key sign-in is available.'),
  anonymous: z.boolean().describe('Whether unauthenticated visitors get read access.'),
});

export const Me = z.object({
  subject: z.string(),
  via: z.enum(['oidc', 'api_key', 'anonymous', 'disabled']),
  scopes: z.array(Scope),
});
