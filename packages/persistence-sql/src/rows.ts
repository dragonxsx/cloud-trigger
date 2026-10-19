import { assertNever } from '@cloud-trigger/core';
import { type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { DateColumn, Epoch, Flag, flag } from './codec.js';
import type { Row, SqlSession } from './session.js';
import {
  type ColumnKind,
  type ColumnSpec,
  type TABLES,
  type TableName,
  tableSpec,
} from './tables.js';

interface KindValues {
  readonly text: string;
  readonly int: number;
  readonly flag: boolean;
  readonly ms: Date;
  readonly long: number;
  readonly real: number;
  readonly doc: unknown;
}

type ValueOf<C> = C extends {
  readonly kind: infer K extends ColumnKind;
  readonly nullable: infer N;
}
  ? KindValues[K] | (N extends true ? null : never)
  : never;

type Columns<T extends TableName> = (typeof TABLES)[T]['columns'];

export type RowValues<T extends TableName> = {
  readonly [K in keyof Columns<T>]: ValueOf<Columns<T>[K]>;
};

export type RowChanges<T extends TableName> = {
  readonly [K in keyof Columns<T>]?: ValueOf<Columns<T>[K]> | undefined;
};

const Real = z.union([z.number(), z.string()]).transform(Number);

const CODECS: Readonly<Record<ColumnKind, z.ZodType>> = {
  text: z.string(),
  int: Epoch,
  flag: Flag,
  ms: DateColumn,
  long: Epoch,
  real: Real,
  doc: z.unknown(),
};

const codecOf = (column: ColumnSpec): z.ZodType =>
  column.nullable ? CODECS[column.kind].nullable() : CODECS[column.kind];

// oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion, typescript/no-unnecessary-type-parameters -- rowParser builds the schema column by column from TABLES[table], so the parsed object has exactly RowValues<T>'s keys and value types
const asRowValues = <T extends TableName>(parsed: Row): RowValues<T> => parsed as RowValues<T>;

export function rowParser<T extends TableName>(table: T): (row: Row) => RowValues<T> {
  const schema = z.looseObject(
    Object.fromEntries(
      Object.entries(tableSpec(table).columns).map(([name, column]) => [name, codecOf(column)]),
    ),
  );

  return (row) => asRowValues<T>(schema.parse(row));
}

const columnSpec = (table: TableName, name: string): ColumnSpec => {
  const column = tableSpec(table).columns[name];
  if (column === undefined) {
    throw new Error(`Table ${table} has no column ${name}`);
  }

  return column;
};

function encode(session: SqlSession, table: TableName, name: string, value: unknown): SQL {
  const column = columnSpec(table, name);
  if (value === null) {
    return sql`${null}`;
  }
  switch (column.kind) {
    case 'doc':
      return session.doc(value);
    case 'ms':
      if (value instanceof Date) {
        return sql`${value.getTime()}`;
      }
      break;
    case 'flag':
      if (typeof value === 'boolean') {
        return sql`${flag(value)}`;
      }
      break;
    case 'text':
      if (typeof value === 'string') {
        return sql`${value}`;
      }
      break;
    case 'int':
    case 'long':
    case 'real':
      if (typeof value === 'number') {
        return sql`${value}`;
      }
      break;
    default:
      return assertNever(column.kind);
  }
  throw new Error(`Column ${table}.${name} cannot store ${typeof value}`);
}

const definedEntries = (values: object): [string, unknown][] =>
  Object.entries(values).filter(([, value]) => value !== undefined);

export function insertInto<T extends TableName>(
  session: SqlSession,
  table: T,
  values: RowValues<T>,
): SQL {
  const entries = definedEntries(values);

  return sql`INSERT INTO ${sql.raw(table)} (${sql.raw(entries.map(([name]) => name).join(', '))})
    VALUES (${sql.join(
      entries.map(([name, value]) => encode(session, table, name, value)),
      sql`, `,
    )})`;
}

export function assignments<T extends TableName>(
  session: SqlSession,
  table: T,
  values: RowChanges<T>,
): SQL {
  return sql.join(
    definedEntries(values).map(
      ([name, value]) => sql`${sql.raw(name)} = ${encode(session, table, name, value)}`,
    ),
    sql`, `,
  );
}
