# Cloud Trigger

Self-hosted service that triggers remote endpoints on a schedule and records every result. It has an API, live monitoring and an analytics dashboard.

- **Triggers:** cron (with timezone, `L`/`#`, and `H` hash spreading), fixed interval, one-off, and RFC 5545 `rrule` calendar rules with excluded dates. All support start/end bounds, a max run count and jitter. `after_job` chains a job to another job's outcome; templates can read the parent run as `{{ parent.* }}`.
- **Event triggers:** inbound webhooks (`POST /hooks/<jobId>/<token>`, optional HMAC, idempotency keys, per-job rate limits) and queue consumers for SQS, Kafka and NATS JetStream (`APP_ROLE=consumer`). Events run at least once and are deduplicated by delivery id, and templates read them as `{{ event.* }}`.
- **Targets:** HTTP with response assertions (status, JSONPath, body, latency) and HMAC signing; GraphQL; gRPC (inline proto or server reflection); Amazon SQS, SNS and EventBridge; Kafka; NATS (core and JetStream); and fan-out to several targets at once (all or any must succeed). Every target passes a shared conformance suite, and more can be added as providers ([docs/providers.md](docs/providers.md)).
- **Reliability:**
  - Overlap policies: allow, forbid, replace, buffer one.
  - Missed-run handling with a grace window: skip, run once, or run all.
  - Retries with backoff, timeouts, and auto-pause after N consecutive failures.
  - Exactly-once firing across replicas.
  - Groups that share default policies, default notifications and rate limits (`perSecond` and `maxConcurrent`, enforced across replicas).
  - SLAs (start delay, duration, time since last success) that flag runs and jobs as late.
  - Idempotent backfill of past fire times.
- **Workflows:** DAGs of jobs, with edges conditioned on success, failure or any outcome, inline steps, approval gates with timeouts (approve or reject through the API or UI), optional schedules, and a live graph view.
- **Notifications:** webhook (signed, with an `Idempotency-Key` header), Slack and email on success, failure, permanent failure or late. Delivery goes through a retried Mongo outbox.
- **Operations:** OpenTelemetry tracing (a span per run attempt, with `traceparent` forwarded to every target), run history, live updates over SSE, a dashboard (outcomes, p50/p95 latency, late runs, top errors), a failed-runs inbox with bulk replay and dismiss, a "Why didn't it run?" explainer, YAML import and export (`/api/jobs/export`, admin scope), status badges (`/badges/jobs/<id>.svg`), an iCal feed of upcoming runs (`/calendar.ics`), Prometheus `/metrics`, and OpenAPI docs at `/docs`.
- **MCP:** an MCP server at `/mcp` (Streamable HTTP, same API keys and OIDC scopes) lets AI agents list, create, run, pause and explain jobs, read runs and analytics, and approve workflow gates.
- **Security:** OIDC (the UI signs in with authorization code + PKCE) or hashed API keys, with `read`/`write`/`admin` scopes. `ANONYMOUS_SCOPES=read` serves read-only wallboards. Secrets are referenced as `{{secret:NAME}}` and redacted in every response and export.

## Architecture

```
apps/web                Refine + Mantine SPA (oRPC data/live/auth providers)
apps/server             NestJS composition root: oRPC contract implementation, roles, health, metrics
packages/api-contract   oRPC contract (zod) — shared by server, web, and generated OpenAPI
packages/engine         Scheduler · Worker · Reaper · JobService · EventIngestor · ConsumerSupervisor (framework-free)
packages/core           Domain model, ports, provider SDK & registry (no I/O)
packages/providers-builtin   cron / interval / once / rrule / after_job / webhook · static / template / event · http / graphql
packages/providers-grpc      gRPC target (inline proto or reflection)
packages/providers-aws       SQS / SNS / EventBridge targets · SQS consumer
packages/providers-kafka     Kafka target and consumer
packages/providers-nats      NATS target and JetStream consumer
packages/persistence-mongo   MongoDB adapter (repositories, lease queue, change streams, analytics)
packages/persistence-sql     Shared SQL repositories (Drizzle sql templates, dialects, unit of work)
packages/persistence-postgres  Postgres adapter (drizzle-kit migrations, SKIP LOCKED claims, LISTEN/NOTIFY)
packages/persistence-sqlite    SQLite adapter for single-node installs (better-sqlite3, in-process events)
packages/testing        Persistence and target conformance suites every adapter must pass
deploy/                 Dockerfile, docker-compose, Helm chart
```

How the scheduler works:

- Due jobs are **claimed with short leases**, so any number of scheduler replicas is safe.
- Each fire time gets an **idempotency key**, backed by a unique index, so a fire time can never run twice.
- Workers claim runs under **renewable leases**. If a worker dies, the reaper requeues its runs.

The storage layer sits behind ports in `packages/core`. Pick it with `DB_DRIVER`: MongoDB (default), Postgres, or SQLite for single-node installs. Every adapter passes the same contract suite in `packages/testing`.

## Quick start

```bash
pnpm install
docker compose -f deploy/docker-compose.yml --profile demo up -d   # MongoDB replica set + echo server
cp .env.example apps/server/.env
pnpm build
pnpm --filter @cloud-trigger/server start   # http://localhost:8080 (API, /docs)
pnpm --filter @cloud-trigger/web dev        # http://localhost:5173 (UI, proxies to :8080)
```

SSO locally: `docker compose -f deploy/docker-compose.yml --profile auth up -d` starts Keycloak on :8081 (user `demo`/`demo`). Then set the `OIDC_*` variables shown in `.env.example`.

Everything in one container: `docker compose -f deploy/docker-compose.yml --profile app up --build`.

Kubernetes:

```bash
helm install ct deploy/helm/cloud-trigger \
  --set secrets.values.MONGO_URI='mongodb://…/?replicaSet=rs0' \
  --set secrets.values.API_KEYS='ci:<sha256>:write'
```

The chart deploys `api`, `scheduler` and `worker` as separate Deployments, with an HPA on workers. Set `combined.enabled=true` to run a single Deployment instead.

API keys are stored as hashes. Generate one with: `printf %s "$KEY" | shasum -a 256`.

## Development

| Command          | What it does                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm lint`      | oxlint, type-aware (`no-explicit-any`, no type assertions, `no-unsafe-*`, exhaustive switches) |
| `pnpm typecheck` | TypeScript 7 strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`)                 |
| `pnpm test`      | Unit, contract and e2e tests. Needs Docker: MongoDB runs via Testcontainers                    |
| `pnpm format`    | oxfmt formatter (also sorts imports)                                                           |

Pinned exceptions to "latest": the web app uses `@refinedev/mantine`, which requires Mantine 5. That in turn means React 18 and React Router 7. Everything else tracks the latest releases; Renovate keeps them current.

## License

MIT. See [LICENSE](LICENSE).
