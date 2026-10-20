export type ColumnKind = 'text' | 'int' | 'flag' | 'ms' | 'long' | 'real' | 'doc';

export interface ColumnSpec {
  readonly kind: ColumnKind;
  readonly nullable: boolean;
  readonly primaryKey: boolean;
}

export interface IndexSpec {
  readonly name: string;
  readonly on: readonly [string, ...string[]];
  readonly unique?: boolean;
  readonly lowercase?: boolean;
  readonly whereNotNull?: boolean;
}

export interface TableSpec {
  readonly columns: Readonly<Record<string, ColumnSpec>>;
  readonly primaryKey?: readonly [string, string];
  readonly indexes?: readonly IndexSpec[];
}

const id = { kind: 'text', nullable: false, primaryKey: true } as const;
const req = <K extends ColumnKind>(kind: K) =>
  ({ kind, nullable: false, primaryKey: false }) as const;
const opt = <K extends ColumnKind>(kind: K) =>
  ({ kind, nullable: true, primaryKey: false }) as const;

export const TABLES = {
  jobs: {
    columns: {
      id,
      name: req('text'),
      enabled: req('flag'),
      paused_reason: opt('text'),
      group_id: opt('text'),
      environment: opt('text'),
      event_source: opt('text'),
      workflow_id: opt('text'),
      next_fire_at: opt('ms'),
      last_fired_at: opt('ms'),
      last_success_at: opt('ms'),
      fire_count: req('int'),
      consecutive_failures: req('int'),
      success_deadline: opt('ms'),
      sla_breached_at: opt('ms'),
      scheduler_owner: opt('text'),
      scheduler_until: opt('ms'),
      version: req('int'),
      created_at: req('ms'),
      updated_at: req('ms'),
      doc: req('doc'),
    },
    indexes: [
      { name: 'jobs_due', on: ['enabled', 'next_fire_at'] },
      { name: 'jobs_group', on: ['group_id'] },
      { name: 'jobs_environment', on: ['environment'], whereNotNull: true },
      { name: 'jobs_name', on: ['name'] },
      { name: 'jobs_success_deadline', on: ['success_deadline'] },
      { name: 'jobs_event_source', on: ['event_source'], whereNotNull: true },
    ],
  },
  job_tags: {
    columns: { job_id: req('text'), tag: req('text') },
    primaryKey: ['job_id', 'tag'],
    indexes: [{ name: 'job_tags_tag', on: ['tag'] }],
  },
  job_upstreams: {
    columns: { job_id: req('text'), upstream_id: req('text') },
    primaryKey: ['job_id', 'upstream_id'],
    indexes: [{ name: 'job_upstreams_upstream', on: ['upstream_id'] }],
  },
  job_connections: {
    columns: { job_id: req('text'), connection_key: req('text'), endpoint_key: req('text') },
    indexes: [
      {
        name: 'job_connections_job',
        on: ['job_id', 'connection_key', 'endpoint_key'],
        unique: true,
      },
      { name: 'job_connections_connection', on: ['connection_key', 'endpoint_key'] },
    ],
  },
  connections: {
    columns: {
      id,
      key: req('text'),
      name: req('text'),
      type: req('text'),
      version: req('int'),
      created_at: req('ms'),
      doc: req('doc'),
    },
    indexes: [
      { name: 'connections_key', on: ['key'], unique: true },
      { name: 'connections_type', on: ['type', 'key'] },
    ],
  },
  connection_environments: {
    columns: { connection_key: req('text'), environment: req('text') },
    primaryKey: ['connection_key', 'environment'],
    indexes: [{ name: 'connection_environments_environment', on: ['environment'] }],
  },
  environments: {
    columns: {
      id,
      key: req('text'),
      name: req('text'),
      version: req('int'),
      created_at: req('ms'),
      doc: req('doc'),
    },
    indexes: [{ name: 'environments_key', on: ['key'], unique: true }],
  },
  runs: {
    columns: {
      id,
      job_id: req('text'),
      status: req('text'),
      reason: req('text'),
      scheduled_at: req('ms'),
      available_at: opt('ms'),
      started_at: opt('ms'),
      lease_worker: opt('text'),
      lease_until: opt('ms'),
      cancel_requested: req('flag'),
      idempotency_key: opt('text'),
      overlap_slot: opt('text'),
      finished_at: opt('ms'),
      late: req('flag'),
      late_reasons: req('text'),
      sla_deadline: opt('ms'),
      sla_max_duration_ms: opt('long'),
      acknowledged_at: opt('ms'),
      rate_limit_key: opt('text'),
      created_at: req('ms'),
      updated_at: req('ms'),
      doc: req('doc'),
    },
    indexes: [
      { name: 'runs_idempotency', on: ['idempotency_key'], unique: true },
      { name: 'runs_overlap_slot', on: ['overlap_slot'], unique: true },
      { name: 'runs_claimable', on: ['status', 'available_at'] },
      { name: 'runs_expired_leases', on: ['status', 'lease_until'] },
      { name: 'runs_job', on: ['job_id', 'status', 'id'] },
      { name: 'runs_scheduled_at', on: ['scheduled_at'] },
      { name: 'runs_failed_inbox', on: ['status', 'acknowledged_at', 'id'] },
      { name: 'runs_rate_limit_slot', on: ['rate_limit_key', 'status'] },
      { name: 'runs_sla_deadline', on: ['sla_deadline'] },
      { name: 'runs_retention', on: ['finished_at'] },
    ],
  },
  fire_keys: {
    columns: { key: id, job_id: req('text'), created_at: req('ms') },
  },
  groups: {
    columns: {
      id,
      name: req('text'),
      environment: opt('text'),
      version: req('int'),
      created_at: req('ms'),
      doc: req('doc'),
    },
    indexes: [
      { name: 'groups_name', on: ['name'], unique: true, lowercase: true },
      { name: 'groups_environment', on: ['environment'], whereNotNull: true },
    ],
  },
  group_connections: {
    columns: { group_id: req('text'), connection_key: req('text'), endpoint_key: req('text') },
    indexes: [
      {
        name: 'group_connections_group',
        on: ['group_id', 'connection_key', 'endpoint_key'],
        unique: true,
      },
      { name: 'group_connections_connection', on: ['connection_key', 'endpoint_key'] },
    ],
  },
  rate_limits: {
    columns: {
      key: id,
      tokens: opt('real'),
      refilled_at: opt('ms'),
      running: req('int'),
      touched_at: opt('ms'),
    },
  },
  notifications_outbox: {
    columns: {
      id,
      key: req('text'),
      run_id: opt('text'),
      status: req('text'),
      available_at: req('ms'),
      lease_worker: opt('text'),
      lease_until: opt('ms'),
      attempts: req('int'),
      last_error: opt('text'),
      delivered_at: opt('ms'),
      rule_index: req('int'),
      created_at: req('ms'),
      updated_at: req('ms'),
      doc: req('doc'),
    },
    indexes: [
      { name: 'outbox_key', on: ['key'], unique: true },
      { name: 'outbox_due', on: ['status', 'available_at'] },
      { name: 'outbox_expired_leases', on: ['status', 'lease_until'] },
      { name: 'outbox_run', on: ['run_id', 'created_at'] },
    ],
  },
  schedule_decisions: {
    columns: { id, job_id: req('text'), at: req('ms'), doc: req('doc') },
    indexes: [
      { name: 'decisions_job_recent', on: ['job_id', 'at'] },
      { name: 'decisions_at', on: ['at'] },
    ],
  },
  run_metrics: {
    columns: {
      id,
      ts: req('ms'),
      job_id: req('text'),
      target_type: req('text'),
      status: req('text'),
      duration_ms: opt('real'),
      status_code: opt('int'),
      attempts: req('int'),
      late: req('flag'),
      error_code: opt('text'),
    },
    indexes: [
      { name: 'metrics_ts', on: ['ts'] },
      { name: 'metrics_job_ts', on: ['job_id', 'ts'] },
    ],
  },
  event_sources: {
    columns: { key: id, owner: req('text'), until: req('ms') },
  },
  workflows: {
    columns: {
      id,
      name: req('text'),
      enabled: req('flag'),
      environment: opt('text'),
      next_fire_at: opt('ms'),
      version: req('int'),
      created_at: req('ms'),
      doc: req('doc'),
    },
    indexes: [
      { name: 'workflows_due', on: ['enabled', 'next_fire_at'] },
      { name: 'workflows_environment', on: ['environment'], whereNotNull: true },
    ],
  },
  workflow_runs: {
    columns: {
      id,
      workflow_id: req('text'),
      status: req('text'),
      idempotency_key: opt('text'),
      has_queued: req('flag'),
      approval_deadline: opt('ms'),
      version: req('int'),
      doc: req('doc'),
    },
    indexes: [
      { name: 'workflow_runs_idempotency', on: ['idempotency_key'], unique: true },
      { name: 'workflow_runs_workflow', on: ['workflow_id', 'id'] },
      { name: 'workflow_runs_status', on: ['status', 'id'] },
      { name: 'workflow_runs_approval_deadline', on: ['approval_deadline'] },
      { name: 'workflow_runs_queued', on: ['has_queued'] },
    ],
  },
  auth_settings: {
    columns: { id, version: req('int'), doc: req('doc') },
  },
  users: {
    columns: {
      id,
      username_lower: req('text'),
      active_admin: req('flag'),
      version: req('int'),
      doc: req('doc'),
    },
    indexes: [{ name: 'users_username', on: ['username_lower'], unique: true }],
  },
  api_keys: {
    columns: { id, hash: req('text'), doc: req('doc') },
    indexes: [{ name: 'api_keys_hash', on: ['hash'], unique: true }],
  },
} as const satisfies Readonly<Record<string, TableSpec>>;

export type TableName = keyof typeof TABLES;

const isTableName = (name: string): name is TableName => name in TABLES;

export const SQL_TABLES: readonly TableName[] = Object.keys(TABLES).filter(isTableName);

export const tableSpec = (name: TableName): TableSpec => TABLES[name];
