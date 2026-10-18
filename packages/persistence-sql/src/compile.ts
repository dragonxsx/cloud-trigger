import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';

export interface CompiledQuery {
  readonly text: string;
  readonly params: readonly unknown[];
}

const pg = new PgDialect();
const sqlite = new SQLiteSyncDialect();

export const compile = (query: SQL, dialect: 'postgres' | 'sqlite'): CompiledQuery => {
  const compiled = (dialect === 'postgres' ? pg : sqlite).sqlToQuery(query);

  return { text: compiled.sql, params: compiled.params };
};
