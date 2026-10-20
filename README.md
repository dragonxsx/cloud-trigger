# Cloud Trigger

Self-hosted service that triggers remote endpoints on a schedule and records every result. It has an API, live monitoring and an analytics dashboard.

- **Triggers:** cron (with timezone, `L`/`#`, and `H` hash spreading), fixed interval, one-off, and RFC 5545 `rrule` calendar rules with excluded dates. All support start/end bounds, a max run count and jitter. `after_job` chains a job to another job's outcome; templates can read the parent run as `{{ parent.* }}`.
- **Event triggers:** inbound webhooks (`POST /hooks/<jobId>/<token>`, optional HMAC, idempotency keys, per-job rate limits) and queue consumers for SQS, Kafka and NATS JetStream (`APP_ROLE=consumer`). Events run at least once and are deduplicated by delivery id, and templates read them as `{{ event.* }}`.
- **Targets:** HTTP with response assertions (status, JSONPath, body, latency) and HMAC signing; GraphQL; gRPC (inline proto or server reflection); Amazon SQS, SNS and EventBridge; Kafka; NATS (core and JetStream); and fan-out to several targets at once (all or any must succeed). Every target passes a shared conformance suite, and more can be added as providers ([docs/providers.md](docs/providers.md)).
- **Connections:** keep every external service's address and credentials in one place (`http` with bearer, basic, API-key or OAuth 2.0 client-credentials auth; `aws`; `kafka`; `nats`; `grpc`; a `slack` webhook; an `smtp` server and sender), with named endpoints such as `billing/charge` (a saved request), `events/orders` (a saved queue, topic or stream) or `mail/oncall` (a saved notification) that jobs and groups pick and can override. Targets, the `sqs`, `kafka` and `nats` event-source triggers, and the `webhook`, `slack` and `email` notifiers all run over connections. Jobs reference connections by key, so an exported job imports unchanged into another deployment that defines the same key. Changes reach the next run (and the next notification attempt), an edit that would break a job or group is refused, and a connection in use cannot be deleted.
- **Environments:** one deployment can serve staging and production side by side. A connection can override its address, credentials and endpoints per environment, and a job, group or workflow picks the environment it runs in (Settings → Environments).
- **OpenAPI import:** generate an `http` connection's endpoints from an OpenAPI 2.0 to 3.2 document (upload, paste or URL). Preview operations by tag, choose what to import, and re-import later to update matching endpoints without losing your edits. Path parameters such as `/pets/{id}` are filled per job with `pathParams`.
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
- **Security:** sign-in is configured in the UI and stored in the database: username and password accounts (argon2), OIDC (the UI signs in with authorization code + PKCE) and hashed API keys, with `read`/`write`/`admin` scopes. Anonymous `read` access serves wallboards. A first-run wizard picks the database and creates the first admin. Secrets are referenced as `{{secret:NAME}}` and redacted in every response and export.

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

The storage layer sits behind ports in `packages/core`. Pick it with `DB_DRIVER`: MongoDB, Postgres, or SQLite for single-node installs. It is inferred from `MONGO_URI` or `POSTGRES_URL` when unset. Every adapter passes the same contract suite in `packages/testing`.

## Quick start

```bash
pnpm install
docker compose -f deploy/docker-compose.yml --profile demo up -d   # MongoDB replica set + echo server
cp .env.example apps/server/.env
echo "DATA_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> apps/server/.env
pnpm build
pnpm --filter @cloud-trigger/server start   # http://localhost:8080 (API, /docs)
pnpm --filter @cloud-trigger/web dev        # http://localhost:5173 (UI, proxies to :8080)
```

### First run

Open the UI. Until setup is done, every page redirects to the wizard at `/setup`:

1. **Setup token.** The server logs a one-time token (`Setup required: open /setup and enter the setup token …`). Set `SETUP_TOKEN` to choose it yourself; you must when more than one replica serves the API.
2. **Database.** Without a usable database the server serves only the wizard. Test a SQLite, Postgres or MongoDB connection there, copy the env vars it prints, and restart. If the configured database is only unreachable, the server keeps retrying and starts once it answers.
3. **Sign-in methods.** Passwords are always on for the admin. Optionally enable OIDC (issuer, UI client id, audience, scope mapping) and anonymous access.
4. **Admin account.** The wizard signs you in as this admin when you finish.

Afterwards, admins change sign-in methods, users and API keys under **Settings**. Until setup is finished every API, MCP and feed request answers `503 SETUP_REQUIRED`. Locked out? `pnpm --filter @cloud-trigger/server reset-admin <username>` (or `node dist/cli.js reset-admin <username>` in the image) sets a new random password, re-enables the account, grants it `admin` and turns password sign-in back on if it was off.

SSO locally: `docker compose -f deploy/docker-compose.yml --profile auth up -d` starts Keycloak on :8081 (user `demo`/`demo`). In Settings → Sign-in methods, enable OIDC with issuer `http://localhost:8081/realms/cloud-trigger`, audience `cloud-trigger` and UI client id `cloud-trigger-web`.

> **Upgrading:** `AUTH_DISABLED`, `API_KEYS`, `ANONYMOUS_SCOPES` and the `OIDC_*` variables were removed and are ignored. After upgrading, the wizard runs once: re-create your API keys and OIDC settings in the UI. `DB_DRIVER` no longer defaults to `mongo`.

Everything in one container: `docker compose -f deploy/docker-compose.yml --profile app up --build`.

Kubernetes:

```bash
helm install ct deploy/helm/cloud-trigger \
  --set secrets.values.MONGO_URI='mongodb://…/?replicaSet=rs0' \
  --set secrets.values.SETUP_TOKEN="$(openssl rand -hex 16)" \
  --set secrets.values.DATA_ENCRYPTION_KEY="$(openssl rand -base64 32)"
```

The chart deploys `api`, `scheduler` and `worker` as separate Deployments, with an HPA on workers. Set `combined.enabled=true` to run a single Deployment instead.

API keys are created in Settings → API keys. The key is shown once, and only its SHA-256 hash is stored.

### Secrets at rest

Fields that providers mark secret (tokens, passwords, secret headers) and the session secret are encrypted with AES-256-GCM before they reach the database. The API still shows them as `***`. `DATA_ENCRYPTION_KEY` is required and must be the same on every replica. **Back it up:** without it, stored secrets cannot be recovered, and once the session secret is encrypted the server refuses to start with a key that doesn't match it.

- **Upgrading:** existing plaintext values keep working and are encrypted the next time they are saved. Run `pnpm --filter @cloud-trigger/server reseal-secrets` (or `node dist/cli.js reseal-secrets` in the image) to encrypt them all at once.
- **Rotating:** set the new key as `DATA_ENCRYPTION_KEY`, move the old one to `DATA_ENCRYPTION_PREVIOUS_KEYS`, restart, then run `reseal-secrets`. Keep the old key until notification outbox retention has passed, because queued deliveries keep their original encryption.

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
