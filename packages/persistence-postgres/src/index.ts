import { fileURLToPath } from 'node:url';

import {
  type DomainEvent,
  JobId,
  type JobChangedEvent,
  LocalEventHub,
  type Unsubscribe,
  isLocalOnlyEvent,
} from '@cloud-trigger/core';
import {
  type ClosableEventBus,
  type CompiledQuery,
  type RawDatabase,
  type RawExecutor,
  type Row,
  type SqlAdapterOptions,
  type SqlPersistence,
  createSession,
  createSqlPersistence,
  loadRunChanged,
  postgresDialect,
} from '@cloud-trigger/persistence-sql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { z } from 'zod';

export interface PostgresPersistenceOptions extends SqlAdapterOptions {
  readonly url: string;
  readonly maxConnections?: number | undefined;
}

export type PostgresPersistence = SqlPersistence;

const Param = z.union([z.string(), z.number(), z.boolean(), z.null()]);
type Param = z.output<typeof Param>;
const params = (query: CompiledQuery): Param[] => query.params.map((value) => Param.parse(value));

const executorFor = (client: postgres.Sql | postgres.TransactionSql): RawExecutor => ({
  all: async (query) => {
    const rows = await client.unsafe<Record<string, unknown>[]>(query.text, params(query));

    return rows.map((row): Row => row);
  },
  run: async (query) => (await client.unsafe(query.text, params(query))).count,
});

const JOB_CHANGES = new Set<JobChangedEvent['change']>(['created', 'updated', 'deleted']);
const JobNotification = z
  .string()
  .transform((payload) => payload.split(':'))
  .pipe(z.tuple([z.string(), JobId]));

class PostgresNotifyEventBus implements ClosableEventBus {
  readonly #hub = new LocalEventHub();
  readonly #listeners: { unlisten(): Promise<void> }[] = [];

  constructor(
    private readonly client: postgres.Sql,
    private readonly loadRun: (id: string) => Promise<DomainEvent | undefined>,
    private readonly onError: (error: unknown) => void,
  ) {}

  readonly start = (): void => {
    const listen = async () => {
      this.#listeners.push(
        await this.client.listen('ct_runs', (id) => {
          void this.#forward(id);
        }),
        await this.client.listen('ct_jobs', (payload) => {
          const parsed = JobNotification.safeParse(payload);
          const change = parsed.success ? parsed.data[0] : undefined;
          const known = [...JOB_CHANGES].find((candidate) => candidate === change);
          if (parsed.success && known) {
            this.#hub.emit({ type: 'job.changed', jobId: parsed.data[1], change: known });
          }
        }),
      );
    };
    listen().catch((error: unknown) => this.onError(error));
  };

  async #forward(id: string): Promise<void> {
    try {
      const event = await this.loadRun(id);
      if (event) {
        this.#hub.emit(event);
      }
    } catch (error: unknown) {
      this.onError(error);
    }
  }

  readonly close = async (): Promise<void> => {
    await Promise.allSettled(this.#listeners.map((listener) => listener.unlisten()));
    this.#listeners.length = 0;
  };

  publish(event: DomainEvent): Promise<void> {
    if (isLocalOnlyEvent(event)) {
      this.#hub.emit(event);
    }

    return Promise.resolve();
  }

  subscribe(handler: (event: DomainEvent) => void): Unsubscribe {
    return this.#hub.subscribe(handler);
  }
}

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));

export function createPostgresPersistence(
  options: PostgresPersistenceOptions,
): PostgresPersistence {
  const client = postgres(options.url, {
    max: options.maxConnections ?? 10,
    onnotice: () => undefined,
  });
  const db: RawDatabase = {
    ...executorFor(client),
    transaction: async <T>(work: (tx: RawExecutor) => Promise<T>): Promise<T> => {
      let commit: (() => T) | undefined;
      await client.begin(async (tx) => {
        const value = await work(executorFor(tx));
        commit = () => value;
      });
      if (commit === undefined) {
        throw new Error('Transaction finished without a result');
      }

      return commit();
    },
  };
  const session = createSession(db, postgresDialect);
  const loadRun = (id: string): Promise<DomainEvent | undefined> => loadRunChanged(session, id);
  const events = new PostgresNotifyEventBus(
    client,
    loadRun,
    options.onEventBusError ?? (() => undefined),
  );

  return createSqlPersistence({
    session,
    events,
    retention: options.retention,
    sweepIntervalMs: options.sweepIntervalMs,
    migrate: async () => {
      await migrate(drizzle(client), { migrationsFolder: MIGRATIONS });
    },
    close: () => client.end({ timeout: 5 }),
  });
}
