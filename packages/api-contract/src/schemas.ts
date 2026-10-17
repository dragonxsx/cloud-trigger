import {
  ConfigIssue,
  GroupId,
  Job,
  JobId,
  JobSpec,
  LintIssue,
  ProviderKind,
  Run,
  RunId,
  RunReason,
  RunStatus,
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
export const RunIdParam = z.object({ id: RunId });

export const JobListQuery = PageQuery.extend({
  search: z.string().optional(),
  tag: z.string().optional(),
  groupId: GroupId.optional(),
  enabled: z.boolean().optional(),
});

export const UpdateJobInput = JobSpec.extend({ id: JobId, expectedVersion: z.int().min(1) });

export const RunListQuery = PageQuery.extend({
  jobId: JobId.optional(),
  status: commaSeparated(RunStatus).optional(),
  reason: RunReason.optional(),
  from: QueryDate.optional(),
  to: QueryDate.optional(),
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

export const Me = z.object({
  subject: z.string(),
  via: z.enum(['oidc', 'api_key', 'anonymous', 'disabled']),
  scopes: z.array(Scope),
});
