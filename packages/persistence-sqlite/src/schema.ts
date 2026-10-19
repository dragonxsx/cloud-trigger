import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

const ms = (name: string) => integer(name, { mode: 'number' });

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    enabled: integer('enabled').notNull(),
    pausedReason: text('paused_reason'),
    groupId: text('group_id'),
    eventSource: text('event_source'),
    workflowId: text('workflow_id'),
    nextFireAt: ms('next_fire_at'),
    lastFiredAt: ms('last_fired_at'),
    lastSuccessAt: ms('last_success_at'),
    fireCount: integer('fire_count').notNull(),
    consecutiveFailures: integer('consecutive_failures').notNull(),
    successDeadline: ms('success_deadline'),
    slaBreachedAt: ms('sla_breached_at'),
    schedulerOwner: text('scheduler_owner'),
    schedulerUntil: ms('scheduler_until'),
    version: integer('version').notNull(),
    createdAt: ms('created_at').notNull(),
    updatedAt: ms('updated_at').notNull(),
    doc: text('doc').notNull(),
  },
  (t) => [
    index('jobs_due').on(t.enabled, t.nextFireAt),
    index('jobs_group').on(t.groupId),
    index('jobs_name').on(t.name),
    index('jobs_success_deadline').on(t.successDeadline),
    index('jobs_event_source')
      .on(t.eventSource)
      .where(sql`${t.eventSource} IS NOT NULL`),
  ],
);

export const jobTags = sqliteTable(
  'job_tags',
  { jobId: text('job_id').notNull(), tag: text('tag').notNull() },
  (t) => [primaryKey({ columns: [t.jobId, t.tag] }), index('job_tags_tag').on(t.tag)],
);

export const jobUpstreams = sqliteTable(
  'job_upstreams',
  { jobId: text('job_id').notNull(), upstreamId: text('upstream_id').notNull() },
  (t) => [
    primaryKey({ columns: [t.jobId, t.upstreamId] }),
    index('job_upstreams_upstream').on(t.upstreamId),
  ],
);

export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull(),
    status: text('status').notNull(),
    reason: text('reason').notNull(),
    scheduledAt: ms('scheduled_at').notNull(),
    availableAt: ms('available_at'),
    startedAt: ms('started_at'),
    leaseWorker: text('lease_worker'),
    leaseUntil: ms('lease_until'),
    cancelRequested: integer('cancel_requested').notNull(),
    idempotencyKey: text('idempotency_key'),
    overlapSlot: text('overlap_slot'),
    finishedAt: ms('finished_at'),
    late: integer('late').notNull(),
    lateReasons: text('late_reasons').notNull(),
    slaDeadline: ms('sla_deadline'),
    slaMaxDurationMs: ms('sla_max_duration_ms'),
    acknowledgedAt: ms('acknowledged_at'),
    rateLimitKey: text('rate_limit_key'),
    createdAt: ms('created_at').notNull(),
    updatedAt: ms('updated_at').notNull(),
    doc: text('doc').notNull(),
  },
  (t) => [
    uniqueIndex('runs_idempotency').on(t.idempotencyKey),
    uniqueIndex('runs_overlap_slot').on(t.overlapSlot),
    index('runs_claimable').on(t.status, t.availableAt),
    index('runs_expired_leases').on(t.status, t.leaseUntil),
    index('runs_job').on(t.jobId, t.status, t.id),
    index('runs_scheduled_at').on(t.scheduledAt),
    index('runs_failed_inbox').on(t.status, t.acknowledgedAt, t.id),
    index('runs_rate_limit_slot').on(t.rateLimitKey, t.status),
    index('runs_sla_deadline').on(t.slaDeadline),
    index('runs_retention').on(t.finishedAt),
  ],
);

export const fireKeys = sqliteTable('fire_keys', {
  key: text('key').primaryKey(),
  jobId: text('job_id').notNull(),
  createdAt: ms('created_at').notNull(),
});

export const groups = sqliteTable(
  'groups',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    version: integer('version').notNull(),
    createdAt: ms('created_at').notNull(),
    doc: text('doc').notNull(),
  },
  (t) => [uniqueIndex('groups_name').on(sql`lower(${t.name})`)],
);

export const rateLimits = sqliteTable('rate_limits', {
  key: text('key').primaryKey(),
  tokens: real('tokens'),
  refilledAt: ms('refilled_at'),
  running: integer('running').notNull(),
  touchedAt: ms('touched_at'),
});

export const notificationsOutbox = sqliteTable(
  'notifications_outbox',
  {
    id: text('id').primaryKey(),
    key: text('key').notNull(),
    runId: text('run_id'),
    status: text('status').notNull(),
    availableAt: ms('available_at').notNull(),
    leaseWorker: text('lease_worker'),
    leaseUntil: ms('lease_until'),
    attempts: integer('attempts').notNull(),
    lastError: text('last_error'),
    deliveredAt: ms('delivered_at'),
    ruleIndex: integer('rule_index').notNull(),
    createdAt: ms('created_at').notNull(),
    updatedAt: ms('updated_at').notNull(),
    doc: text('doc').notNull(),
  },
  (t) => [
    uniqueIndex('outbox_key').on(t.key),
    index('outbox_due').on(t.status, t.availableAt),
    index('outbox_expired_leases').on(t.status, t.leaseUntil),
    index('outbox_run').on(t.runId, t.createdAt),
  ],
);

export const scheduleDecisions = sqliteTable(
  'schedule_decisions',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull(),
    at: ms('at').notNull(),
    doc: text('doc').notNull(),
  },
  (t) => [index('decisions_job_recent').on(t.jobId, t.at), index('decisions_at').on(t.at)],
);

export const runMetrics = sqliteTable(
  'run_metrics',
  {
    id: text('id').primaryKey(),
    ts: ms('ts').notNull(),
    jobId: text('job_id').notNull(),
    targetType: text('target_type').notNull(),
    status: text('status').notNull(),
    durationMs: real('duration_ms'),
    statusCode: integer('status_code'),
    attempts: integer('attempts').notNull(),
    late: integer('late').notNull(),
    errorCode: text('error_code'),
  },
  (t) => [index('metrics_ts').on(t.ts), index('metrics_job_ts').on(t.jobId, t.ts)],
);

export const eventSources = sqliteTable('event_sources', {
  key: text('key').primaryKey(),
  owner: text('owner').notNull(),
  until: ms('until').notNull(),
});

export const workflows = sqliteTable(
  'workflows',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    enabled: integer('enabled').notNull(),
    nextFireAt: ms('next_fire_at'),
    version: integer('version').notNull(),
    createdAt: ms('created_at').notNull(),
    doc: text('doc').notNull(),
  },
  (t) => [index('workflows_due').on(t.enabled, t.nextFireAt)],
);

export const workflowRuns = sqliteTable(
  'workflow_runs',
  {
    id: text('id').primaryKey(),
    workflowId: text('workflow_id').notNull(),
    status: text('status').notNull(),
    idempotencyKey: text('idempotency_key'),
    hasQueued: integer('has_queued').notNull(),
    approvalDeadline: ms('approval_deadline'),
    version: integer('version').notNull(),
    doc: text('doc').notNull(),
  },
  (t) => [
    uniqueIndex('workflow_runs_idempotency').on(t.idempotencyKey),
    index('workflow_runs_workflow').on(t.workflowId, t.id),
    index('workflow_runs_status').on(t.status, t.id),
    index('workflow_runs_approval_deadline').on(t.approvalDeadline),
    index('workflow_runs_queued').on(t.hasQueued),
  ],
);

export const authSettings = sqliteTable('auth_settings', {
  id: text('id').primaryKey(),
  version: integer('version').notNull(),
  doc: text('doc').notNull(),
});

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    usernameLower: text('username_lower').notNull(),
    activeAdmin: integer('active_admin').notNull(),
    version: integer('version').notNull(),
    doc: text('doc').notNull(),
  },
  (t) => [uniqueIndex('users_username').on(t.usernameLower)],
);

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    hash: text('hash').notNull(),
    doc: text('doc').notNull(),
  },
  (t) => [uniqueIndex('api_keys_hash').on(t.hash)],
);
