# Cloud Trigger

Self-hosted service that triggers remote endpoints on a schedule and records every result. It has an API, live monitoring and an analytics dashboard.

- **Triggers:** cron (with timezone, `L`/`#`, and `H` hash spreading), fixed interval, and one-off. All support start/end bounds, a max run count and jitter.
- **Targets:** HTTP with response assertions (status, JSONPath, body, latency) and HMAC signing. gRPC, SQS and others can be added as providers ([docs/providers.md](docs/providers.md)).
- **Reliability:**
  - Overlap policies: allow, forbid, replace, buffer one.
  - Missed-run handling with a grace window: skip, run once, or run all.
  - Retries with backoff, timeouts, and auto-pause after N consecutive failures.
  - Exactly-once firing across replicas.
- **Operations:** run history, live updates over SSE, a dashboard (outcomes, p50/p95 latency, top errors), Prometheus `/metrics`, and OpenAPI docs at `/docs`.
- **Security:** OIDC bearer tokens or hashed API keys with `read`/`write`/`admin` scopes. Secrets are referenced as `{{secret:NAME}}` and redacted in every response.

## Architecture

```
apps/web                Refine + Mantine SPA (oRPC data/live/auth providers)
apps/server             NestJS composition root: oRPC contract implementation, roles, health, metrics
packages/api-contract   oRPC contract (zod) — shared by server, web, and generated OpenAPI
packages/engine         Scheduler · Worker · Reaper · JobService (framework-free)
packages/core           Domain model, ports, provider SDK & registry (no I/O)
packages/providers-builtin   cron / interval / once · static / template · http
packages/persistence-mongo   MongoDB adapter (repositories, lease queue, change streams, analytics)
packages/testing        Persistence contract test-suite every adapter must pass
deploy/                 Dockerfile, docker-compose, Helm chart
```

How the scheduler works:

- Due jobs are **claimed with short leases**, so any number of scheduler replicas is safe.
- Each fire time gets an **idempotency key**, backed by a unique index, so a fire time can never run twice.
- Workers claim runs under **renewable leases**. If a worker dies, the reaper requeues its runs.

The storage layer sits behind ports in `packages/core`. Swapping MongoDB for Postgres or SQLite means writing a new `persistence-*` package and passing `packages/testing`.

## Quick start

```bash
pnpm install
docker compose -f deploy/docker-compose.yml --profile demo up -d   # MongoDB replica set + echo server
cp .env.example apps/server/.env
pnpm build
pnpm --filter @cloud-trigger/server start   # http://localhost:8080 (API, /docs)
pnpm --filter @cloud-trigger/web dev        # http://localhost:5173 (UI, proxies to :8080)
```

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
