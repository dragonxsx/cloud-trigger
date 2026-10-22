---
paths:
  - 'packages/**'
  - 'apps/server/**'
---

# Domain and errors (`packages/core`)

- **Zod 4 schemas are the single source of truth.** Types come from `z.output<typeof X>` (or `z.input` for raw input). Don't hand-write interfaces that duplicate a schema.
- **IDs** are branded UUIDv7 values (`JobId`, `RunId`, `GroupId`; create them with `newJobId()` etc.).
- **State lives in discriminated unions.** For example, `Run` is keyed by `status`. Transitions are pure functions in `domain/run.ts` (`startRun`, `finishAttempt`, `expireLease`, …) that return the next state, and they are unit-tested.
- **Expected failures are values.** Return `neverthrow`'s `Result<T, DomainError<'code'> | ConfigError>`, re-exported from core. Throw only for bugs and infrastructure faults.
  - The server maps errors to HTTP in one place, `toApiError` in `apps/server/src/api/shared/api.ts`. Add a case there for every new error code; the exhaustive switch forces it.
- **Ports** (`src/ports`) are plain interfaces with readonly inputs, and optional fields are typed `?: T | undefined`.
  - Pages return `{ items, nextCursor, total }` and accept either a `cursor` or an `offset`.
  - Lists page newest first by default. A list that supports sorting (today only jobs: `JobQuery.sort`, `sort`/`order` on `GET /jobs`) orders the whole result in the database, puts nulls last in both directions and breaks ties newest first. A sorted page uses `offset` only and returns `nextCursor: null`; the contract rejects `cursor` with `sort`. The adapters reuse `findSortedPage` (Mongo `cursor.ts`) and `sortedPage` (SQL `query.ts`), and the UI sends Refine sorters through the data provider (`sorters: { mode: 'server' }`).
  - Time always comes from the `Clock` port and is never read directly with `new Date()`, so tests can control it. Providers receive it as `ctx.now` (`RunContext` and the trigger `lint` context).
- **Connections are referenced by key, never by id**, so exported jobs stay portable between deployments. Triggers, targets and notifiers all reference them with a `ConnectionRef` (`{ key, endpoint? }`). `Job.connectionRefs` is derived on save with `jobConnectionRefs` (trigger, target and notifications), like `upstreamJobIds`, and `Group.connectionRefs` with `notificationConnectionRefs` (default notifications); persistence indexes them (`job_connections` and `group_connections` in SQL) and never reads provider config.
- **Environments** select per-environment connection overlays (`ConnectionSpec.overlays`, merge patches over the base config and endpoints). `Job`, `Group` and `Workflow` have an optional `environment`. The effective one is the job's, or else its group's (`resolvePolicy(...).environment`, `PolicyResolver.environment(job)`), and workflows copy theirs into inline steps. Never read `connection.overlays` in the engine; let `loadConnections(repo, refs, environment)` apply them. Its `environment` argument is required on purpose, so every caller decides. Persistence indexes `environment` (an `environment` column on jobs, groups and workflows, and `connection_environments` in SQL) only so that `findByEnvironment` can guard deletes.
- An `Endpoint` is `{ target }`, `{ source }` or `{ notifier }`. Read it through `endpointProvider` (and rebuild it with `withEndpointProvider`), never with `'target' in` checks.
- **`JobSpec.policy` is a `JobPolicyPatch` that holds overrides only.** Never read `job.policy.*` in the engine. Resolve the effective policy (job wins over group, then system defaults) with `PolicyResolver` from `packages/engine/src/policies.ts`, or with `effectivePolicy()` in pure code.
