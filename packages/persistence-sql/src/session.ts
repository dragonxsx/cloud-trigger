import { AsyncLocalStorage } from 'node:async_hooks';

import type { UnitOfWork } from '@cloud-trigger/core';
import type { SQL } from 'drizzle-orm';

import { encodeDoc } from './codec.js';
import { type CompiledQuery, compile } from './compile.js';

export type Row = Readonly<Record<string, unknown>>;

export interface RawExecutor {
  all(query: CompiledQuery): Promise<readonly Row[]>;
  /** Returns the number of affected rows. */
  run(query: CompiledQuery): Promise<number>;
}

export interface RawDatabase extends RawExecutor {
  transaction<T>(work: (tx: RawExecutor) => Promise<T>): Promise<T>;
}

export interface SqlExecutor {
  all(query: SQL): Promise<readonly Row[]>;
  run(query: SQL): Promise<number>;
}

export interface SqlDialect {
  readonly name: 'postgres' | 'sqlite';
  json(value: string): SQL;
  /** Appended to a SELECT whose rows are about to be updated in the same transaction. */
  readonly forUpdate: SQL;
  /** Appended to a claim sub-select so concurrent claimers skip each other's rows. */
  readonly skipLocked: SQL;
  readonly caseInsensitiveLike: SQL;
  isUniqueViolation(error: unknown): boolean;
  percentiles(
    exec: SqlExecutor,
    where: SQL,
    ps: readonly number[],
  ): Promise<readonly (number | null)[]>;
  bucketP95(exec: SqlExecutor, where: SQL, bucketMs: number): Promise<ReadonlyMap<number, number>>;
}

const compiling = (raw: RawExecutor, dialect: SqlDialect['name']): SqlExecutor => ({
  all: (query) => raw.all(compile(query, dialect)),
  run: (query) => raw.run(compile(query, dialect)),
});

export class SqlSession implements UnitOfWork {
  readonly atomic = true;
  readonly #current = new AsyncLocalStorage<SqlExecutor>();
  readonly #root: SqlExecutor;

  constructor(
    private readonly db: RawDatabase,
    readonly dialect: SqlDialect,
  ) {
    this.#root = compiling(db, dialect.name);
  }

  doc(value: unknown): SQL {
    return this.dialect.json(encodeDoc(value));
  }

  get exec(): SqlExecutor {
    return this.#current.getStore() ?? this.#root;
  }

  all(query: SQL): Promise<readonly Row[]> {
    return this.exec.all(query);
  }

  run(query: SQL): Promise<number> {
    return this.exec.run(query);
  }

  transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.#current.getStore()) {
      return work();
    }

    return this.db.transaction((tx) => this.#current.run(compiling(tx, this.dialect.name), work));
  }
}
