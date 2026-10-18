import { isRecord } from '@cloud-trigger/core';
import { type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { Epoch } from './codec.js';
import type { SqlDialect, SqlExecutor } from './session.js';

const causes = (error: unknown): unknown[] =>
  error instanceof Error && error.cause !== undefined ? [error, ...causes(error.cause)] : [error];

const hasCode = (error: unknown, codes: ReadonlySet<string>): boolean =>
  causes(error).some(
    (cause) => isRecord(cause) && typeof cause['code'] === 'string' && codes.has(cause['code']),
  );

const Duration = z.union([z.number(), z.string()]).transform(Number);
const NullableDuration = Duration.nullable();

const PG_UNIQUE = new Set(['23505']);

export const postgresDialect: SqlDialect = {
  name: 'postgres',
  json: (value) => sql`${value}::jsonb`,
  forUpdate: sql`FOR UPDATE`,
  skipLocked: sql`FOR UPDATE SKIP LOCKED`,
  caseInsensitiveLike: sql`ILIKE`,
  isUniqueViolation: (error) => hasCode(error, PG_UNIQUE),
  async percentiles(exec, where, ps) {
    const columns = sql.join(
      ps.map(
        (p, i) =>
          sql`percentile_cont(${sql.raw(String(p))}) WITHIN GROUP (ORDER BY duration_ms) AS ${sql.raw(`p${i}`)}`,
      ),
      sql`, `,
    );
    const [row] = await exec.all(sql`SELECT ${columns} FROM run_metrics WHERE ${where}`);

    return ps.map((_, i) => (row ? NullableDuration.parse(row[`p${i}`] ?? null) : null));
  },
  async bucketP95(exec, where, bucketMs) {
    const size = sql.raw(String(bucketMs));
    const rows = await exec.all(sql`
      SELECT (ts / ${size}) * ${size} AS bucket,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95
      FROM run_metrics WHERE ${where} GROUP BY bucket`);

    return new Map(
      rows.flatMap((row) => {
        const p95 = NullableDuration.parse(row['p95'] ?? null);

        return p95 === null ? [] : [[Epoch.parse(row['bucket']), p95] as const];
      }),
    );
  },
};

const SQLITE_UNIQUE = new Set(['SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT_PRIMARYKEY']);
const PERCENTILE_WINDOW = 100_000;

const percentileOf = (sorted: readonly number[], p: number): number | null => {
  if (sorted.length === 0) {
    return null;
  }
  const rank = p * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const lower = sorted[low] ?? 0;
  const upper = sorted[high] ?? lower;

  return lower + (upper - lower) * (rank - low);
};

const durations = async (exec: SqlExecutor, where: SQL, extra: SQL = sql``) =>
  exec.all(sql`
    SELECT ${extra} duration_ms FROM run_metrics WHERE ${where} AND duration_ms IS NOT NULL
    ORDER BY ts DESC LIMIT ${PERCENTILE_WINDOW}`);

export const sqliteDialect: SqlDialect = {
  name: 'sqlite',
  json: (value) => sql`${value}`,
  forUpdate: sql``,
  skipLocked: sql``,
  caseInsensitiveLike: sql`LIKE`,
  isUniqueViolation: (error) => hasCode(error, SQLITE_UNIQUE),
  async percentiles(exec, where, ps) {
    const rows = await durations(exec, where);
    const sorted = rows.map((row) => Duration.parse(row['duration_ms'])).toSorted((a, b) => a - b);

    return ps.map((p) => percentileOf(sorted, p));
  },
  async bucketP95(exec, where, bucketMs) {
    const size = sql.raw(String(bucketMs));
    const rows = await durations(exec, where, sql`(ts / ${size}) * ${size} AS bucket,`);
    const byBucket = new Map<number, number[]>();
    for (const row of rows) {
      const bucket = Epoch.parse(row['bucket']);
      byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), Duration.parse(row['duration_ms'])]);
    }

    return new Map(
      [...byBucket.entries()].flatMap(([bucket, values]) => {
        const p95 = percentileOf(
          values.toSorted((a, b) => a - b),
          0.95,
        );

        return p95 === null ? [] : [[bucket, p95] as const];
      }),
    );
  },
};
