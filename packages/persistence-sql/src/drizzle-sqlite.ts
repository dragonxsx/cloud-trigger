import { assertNever } from '@cloud-trigger/core';
import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  type SQLiteColumnBuilderBase,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

import { type ColumnSpec, type TableName, tableSpec } from './tables.js';

interface Modifiable extends SQLiteColumnBuilderBase {
  notNull(): SQLiteColumnBuilderBase;
  primaryKey(): SQLiteColumnBuilderBase;
}

const finish = (builder: Modifiable, column: ColumnSpec): SQLiteColumnBuilderBase =>
  column.primaryKey ? builder.primaryKey() : column.nullable ? builder : builder.notNull();

const sqliteColumn = (name: string, column: ColumnSpec): SQLiteColumnBuilderBase => {
  switch (column.kind) {
    case 'text':
    case 'doc':
      return finish(text(name), column);
    case 'int':
    case 'flag':
      return finish(integer(name), column);
    case 'ms':
    case 'long':
      return finish(integer(name, { mode: 'number' }), column);
    case 'real':
      return finish(real(name), column);
    default:
      return assertNever(column.kind);
  }
};

const columnOf = (columns: Readonly<Record<string, AnySQLiteColumn>>, name: string) => {
  const column = columns[name];
  if (column === undefined) {
    throw new Error(`Unknown column ${name}`);
  }

  return column;
};

const sqliteTableOf = (name: TableName) => {
  const spec = tableSpec(name);

  return sqliteTable(
    name,
    Object.fromEntries(
      Object.entries(spec.columns).map(([column, c]) => [column, sqliteColumn(column, c)]),
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

export const jobs = sqliteTableOf('jobs');
export const jobTags = sqliteTableOf('job_tags');
export const jobUpstreams = sqliteTableOf('job_upstreams');
export const jobConnections = sqliteTableOf('job_connections');
export const connections = sqliteTableOf('connections');
export const runs = sqliteTableOf('runs');
export const fireKeys = sqliteTableOf('fire_keys');
export const groups = sqliteTableOf('groups');
export const groupConnections = sqliteTableOf('group_connections');
export const rateLimits = sqliteTableOf('rate_limits');
export const notificationsOutbox = sqliteTableOf('notifications_outbox');
export const scheduleDecisions = sqliteTableOf('schedule_decisions');
export const runMetrics = sqliteTableOf('run_metrics');
export const eventSources = sqliteTableOf('event_sources');
export const workflows = sqliteTableOf('workflows');
export const workflowRuns = sqliteTableOf('workflow_runs');
export const authSettings = sqliteTableOf('auth_settings');
export const users = sqliteTableOf('users');
export const apiKeys = sqliteTableOf('api_keys');
