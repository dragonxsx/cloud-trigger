---
paths:
  - 'packages/persistence-*/**'
  - 'packages/testing/**'
---

# Persistence (`packages/persistence-*`)

- Every adapter must pass `describePersistenceContract` from `packages/testing`. When you add a port method, add a contract test there **first**.
- Adapters: `persistence-mongo`, `persistence-postgres` and `persistence-sqlite`. The two SQL adapters share their repositories in `persistence-sql`; change SQL behaviour there, once. `DB_DRIVER` picks the adapter (`apps/server/src/infra/persistence/persistence.ts`).
- Rules that don't depend on the database live in `packages/core/src/store` and both adapter families call them. Never restate them in an adapter. They cover error constructors (`notFound`, `versionConflict`, `staleRun`, …), update field sets (`groupUpdateFields`, `workflowChangeFields`, `userEditableJobFields`), derived index fields (`workflowRunIndex`), token-bucket math (`attemptAcquire`, `acquireResult`), the analytics summary (`summarizeRuns`), `LocalEventHub` and `DEFAULT_RETENTION`. Adapters keep only what the store has to do atomically, such as Mongo's rate-limit pipeline.
- Inside an adapter, reuse its helpers rather than repeating the pattern:
  - Mongo (`errors.ts`, `documents.ts`): `unlessDuplicateKey`, `casMissed`, `caseInsensitiveMatch`, `toDocument`, `documentParser`.
  - SQL (`query.ts`, `codec.ts`, `rows.ts`): `session.doc(value)`, `docParser`, `containsInsensitive`, `rowParser`, `insertInto`, `assignments`.
- SQL tables keep the full entity in a JSON `doc` plus "hot" columns that are the source of truth for atomically changed fields. Update the hot columns, never just the doc, for leases, status, schedule state and SLA flags. Write SQL with persistence-sql's `sql` template only; dialect packages run compiled text and parameters, because their drizzle-orm copies differ.
- The SQL schema has one source: `TABLES` in `persistence-sql/src/tables.ts`, a dialect-neutral spec of columns (`text`, `int`, `flag`, `ms`, `long`, `real`, `doc`) and indexes.
  - `drizzle-pg.ts` and `drizzle-sqlite.ts` build both drizzle schemas from it, and each dialect's `src/schema.ts` only re-exports one of them for drizzle-kit.
  - The same spec types `rowParser`, `insertInto` and `assignments`. A column missing from the spec, or holding the wrong type, fails typecheck.
  - To change the schema, edit `tables.ts`, then run `pnpm --filter @cloud-trigger/persistence-postgres db:generate` and the same for `persistence-sqlite`. The script builds `persistence-sql` first, because drizzle-kit loads its `dist`. Never edit a released migration.
- Postgres infers untyped parameters inside `CASE` as `text`; wrap them in `CAST(... AS BIGINT)`.
- Multi-write operations that must be all-or-nothing go through `persistence.unitOfWork.transaction`. It is atomic on SQL and best-effort on Mongo (`atomic: false`).
- Because Mongo's unit of work is not atomic, order writes so a partial failure stays recoverable (setup inserts the admin before the settings). Re-check cross-replica invariants, such as "some admin can sign in", after the write: the in-process `Mutex` only serializes one replica.
- Engine integration tests run once per adapter as Vitest projects (`ENGINE_DB`: `mongo`, `postgres`, `sqlite`); use `h.clear([...tables])` instead of driver calls.
- Each adapter exports `./testing` (`startTestMongo`, `startTestPostgres`, `startTestSqlite`), which returns `{ persistence, clear, stop }`. Contract tests and `engine/test/databases.ts` use it, so container images, table lists and the SQLite guard key live in one place per adapter. Override images with `MONGO_IMAGE` and `POSTGRES_IMAGE`.
- SQLite uses one connection behind an async mutex. Never hold a transaction open across an external call such as HTTP, because every other query waits for it.
- Adapters store secret fields as `ctenc:v1:<keyId>:<iv>:<ciphertext>` strings and never encrypt or decrypt themselves (`sealedPersistence` does, see the providers rules). The key is `DATA_ENCRYPTION_KEY` (AES-256-GCM, `apps/server/src/infra/crypto`). Rotation is in the README (**Secrets at rest**): keep the old key until outbox retention (`DEFAULT_RETENTION`) has passed, because outbox rows are not resealed.

## MongoDB

- Use the official `mongodb` driver only, no ODM. Collections are typed (`Collection<JobDocument>`), and documents are mapped back through zod on read (`documents.ts`).
- Create indexes in `ensureIndexes`, which `migrate()` runs idempotently at startup.
- Inside a Mongo transaction, a duplicate-key error aborts the whole transaction. Dedupe with an `$setOnInsert` upsert instead of catching the error (see `MongoScheduleStore.commitFire`).
- Analytics goes to the time-series `run_metrics` collection, which can live in a separate DB through `ANALYTICS_MONGO_URI`. `$percentile` needs MongoDB 7 or later.
