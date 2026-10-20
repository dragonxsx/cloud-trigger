import { assertNever } from '@cloud-trigger/core';
import { sql } from 'drizzle-orm';
import {
  type ExtraConfigColumn,
  type PgColumnBuilderBase,
  bigint,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { type ColumnSpec, type TableName, tableSpec } from './tables.js';

interface Modifiable extends PgColumnBuilderBase {
  notNull(): PgColumnBuilderBase;
  primaryKey(): PgColumnBuilderBase;
}

const finish = (builder: Modifiable, column: ColumnSpec): PgColumnBuilderBase =>
  column.primaryKey ? builder.primaryKey() : column.nullable ? builder : builder.notNull();

const pgColumn = (name: string, column: ColumnSpec): PgColumnBuilderBase => {
  switch (column.kind) {
    case 'text':
      return finish(text(name), column);
    case 'int':
    case 'flag':
      return finish(integer(name), column);
    case 'ms':
    case 'long':
      return finish(bigint(name, { mode: 'number' }), column);
    case 'real':
      return finish(doublePrecision(name), column);
    case 'doc':
      return finish(jsonb(name), column);
    default:
      return assertNever(column.kind);
  }
};

const columnOf = (columns: Readonly<Record<string, ExtraConfigColumn>>, name: string) => {
  const column = columns[name];
  if (column === undefined) {
    throw new Error(`Unknown column ${name}`);
  }

  return column;
};

const pgTableOf = (name: TableName) => {
  const spec = tableSpec(name);

  return pgTable(
    name,
    Object.fromEntries(
      Object.entries(spec.columns).map(([column, c]) => [column, pgColumn(column, c)]),
    ),
    (t) => {
      const pick = (column: string) => columnOf(t, column);
      const indexes = (spec.indexes ?? []).map((i) => {
        const first = pick(i.on[0]);
        const rest = i.on.slice(1).map(pick);
        const build = (i.unique === true ? uniqueIndex : index)(i.name);
        const on = i.lowercase === true ? build.on(sql`lower(${first})`) : build.on(first, ...rest);

        return i.whereNotNull === true ? on.where(sql`${first} IS NOT NULL`) : on;
      });

      return spec.primaryKey
        ? [
            primaryKey({ columns: [pick(spec.primaryKey[0]), pick(spec.primaryKey[1])] }),
            ...indexes,
          ]
        : indexes;
    },
  );
};

export const jobs = pgTableOf('jobs');
export const jobTags = pgTableOf('job_tags');
export const jobUpstreams = pgTableOf('job_upstreams');
export const jobConnections = pgTableOf('job_connections');
export const connections = pgTableOf('connections');
export const connectionEnvironments = pgTableOf('connection_environments');
export const environments = pgTableOf('environments');
export const runs = pgTableOf('runs');
export const fireKeys = pgTableOf('fire_keys');
export const groups = pgTableOf('groups');
export const groupConnections = pgTableOf('group_connections');
export const rateLimits = pgTableOf('rate_limits');
export const notificationsOutbox = pgTableOf('notifications_outbox');
export const scheduleDecisions = pgTableOf('schedule_decisions');
export const runMetrics = pgTableOf('run_metrics');
export const eventSources = pgTableOf('event_sources');
export const workflows = pgTableOf('workflows');
export const workflowRuns = pgTableOf('workflow_runs');
export const authSettings = pgTableOf('auth_settings');
export const users = pgTableOf('users');
export const apiKeys = pgTableOf('api_keys');
