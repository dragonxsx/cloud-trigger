import { getTableColumns, getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { compile } from './compile.js';
import { postgresDialect, sqliteDialect } from './dialects.js';
import * as pg from './drizzle-pg.js';
import * as sqlite from './drizzle-sqlite.js';
import { assignments, insertInto, rowParser } from './rows.js';
import { type RawDatabase, SqlSession } from './session.js';
import { SQL_TABLES, tableSpec } from './tables.js';

const unused = (): never => {
  throw new Error('not connected');
};
const offline: RawDatabase = { all: unused, run: unused, transaction: unused };

const columnsByTable = (entries: readonly (readonly [string, readonly string[]])[]) =>
  Object.fromEntries(entries.map(([name, columns]) => [name, columns.toSorted()]));

describe('table spec', () => {
  it.each([
    ['postgres', Object.values(pg)],
    ['sqlite', Object.values(sqlite)],
  ])('builds every %s table with exactly the spec columns', (_dialect, tables) => {
    expect(
      columnsByTable(
        tables.map((table) => [getTableName(table), Object.keys(getTableColumns(table))]),
      ),
    ).toEqual(
      columnsByTable(SQL_TABLES.map((name) => [name, Object.keys(tableSpec(name).columns)])),
    );
  });
});

describe('row helpers', () => {
  it('encodes dates, flags, nulls and documents per dialect', () => {
    const session = new SqlSession(offline, postgresDialect);
    const query = compile(
      insertInto(session, 'event_sources', {
        key: 'k',
        owner: 'me',
        until: new Date(42),
      }),
      'postgres',
    );

    expect(query.text.replace(/\s+/g, ' ')).toBe(
      'INSERT INTO event_sources (key, owner, until) VALUES ($1, $2, $3)',
    );
    expect(query.params).toEqual(['k', 'me', 42]);
  });

  it('writes documents as jsonb on postgres and text on sqlite', () => {
    const values = { id: 'a', version: 1, doc: { at: new Date(0) } };
    const onPg = compile(
      assignments(new SqlSession(offline, postgresDialect), 'auth_settings', values),
      'postgres',
    );
    const onSqlite = compile(
      assignments(new SqlSession(offline, sqliteDialect), 'auth_settings', values),
      'sqlite',
    );

    expect(onPg.text).toBe('id = $1, version = $2, doc = $3::jsonb');
    expect(onSqlite.text).toBe('id = ?, version = ?, doc = ?');
    expect(onSqlite.params[2]).toBe('{"at":{"$date":"1970-01-01T00:00:00.000Z"}}');
  });

  it('skips undefined changes and stores booleans as 0 or 1', () => {
    const query = compile(
      assignments(new SqlSession(offline, sqliteDialect), 'workflows', {
        enabled: false,
        next_fire_at: undefined,
        name: 'n',
      }),
      'sqlite',
    );

    expect(query.text).toBe('enabled = ?, name = ?');
    expect(query.params).toEqual([0, 'n']);
  });

  it('parses driver values into typed rows', () => {
    const parse = rowParser('rate_limits');

    expect(
      parse({ key: 'k', tokens: '0.5', refilled_at: 10n, running: '2', touched_at: null }),
    ).toEqual({ key: 'k', tokens: 0.5, refilled_at: new Date(10), running: 2, touched_at: null });
  });
});
