import type { Page, PageRequest, SortOrder } from '@cloud-trigger/core';
import { type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { Count } from './codec.js';
import type { Row, SqlDialect, SqlSession } from './session.js';

export const and = (conditions: readonly (SQL | undefined)[]): SQL => {
  const present = conditions.filter((condition) => condition !== undefined);

  return present.length === 0 ? sql`1 = 1` : sql.join(present, sql` AND `);
};

export const inList = (values: readonly (string | number)[]): SQL =>
  sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );

export const sameAs = (dialect: SqlDialect): SQL =>
  dialect.name === 'postgres' ? sql`IS NOT DISTINCT FROM` : sql`IS`;

export const likePattern = (search: string): string =>
  `%${search.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;

export const containsInsensitive = (
  dialect: SqlDialect,
  column: string,
  search: string | undefined,
): SQL | undefined =>
  search
    ? sql`${sql.raw(column)} ${dialect.caseInsensitiveLike} ${likePattern(search)} ESCAPE '\\'`
    : undefined;

const NO_LIMIT = 1_000_000_000;
export const ALL_ROWS = sql.raw(String(NO_LIMIT));

export async function newestFirstPage<T>(
  session: SqlSession,
  table: SQL,
  where: SQL,
  query: PageRequest,
  map: (row: Row) => T,
): Promise<Page<T>> {
  const pageWhere = query.cursor ? and([where, sql`id < ${query.cursor}`]) : where;
  const offset = query.cursor ? 0 : (query.offset ?? 0);
  const [rows, counted] = await Promise.all([
    session.all(
      sql`SELECT * FROM ${table} WHERE ${pageWhere} ORDER BY id DESC LIMIT ${query.limit + 1} OFFSET ${offset}`,
    ),
    session.all(sql`SELECT count(*) AS count FROM ${table} WHERE ${where}`),
  ]);
  const items = rows.slice(0, query.limit);
  const hasMore = rows.length > query.limit;
  const last = items.at(-1);

  return {
    items: items.map(map),
    nextCursor: hasMore && last ? z.string().parse(last['id']) : null,
    total: Count.parse(counted[0]).count,
  };
}

export async function sortedPage<T>(
  session: SqlSession,
  table: SQL,
  where: SQL,
  query: PageRequest,
  sort: { readonly key: SQL; readonly order: SortOrder },
  map: (row: Row) => T,
): Promise<Page<T>> {
  const direction = sql.raw(sort.order === 'asc' ? 'ASC' : 'DESC');
  const [rows, counted] = await Promise.all([
    session.all(
      sql`SELECT * FROM ${table} WHERE ${where} ORDER BY CASE WHEN ${sort.key} IS NULL THEN 1 ELSE 0 END, ${sort.key} ${direction}, id DESC LIMIT ${query.limit} OFFSET ${query.offset ?? 0}`,
    ),
    session.all(sql`SELECT count(*) AS count FROM ${table} WHERE ${where}`),
  ]);

  return { items: rows.map(map), nextCursor: null, total: Count.parse(counted[0]).count };
}
