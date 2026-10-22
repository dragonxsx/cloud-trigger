---
paths:
  - 'deploy/**'
  - 'apps/server/src/config/**'
---

# Deployment

- One image serves every role (`deploy/Dockerfile`, node:24-alpine, non-root). The role is chosen with `APP_ROLE=api|scheduler|worker|consumer|all`.
- Local stack: `docker compose -f deploy/docker-compose.yml up -d` starts Mongo 8 as a single-node replica set, which change streams require. Profiles `demo` and `app` add the echo mock target and the app. The profiles `postgres`, `localstack`, `kafka` and `nats` add the other backends.
- The Helm chart is at `deploy/helm/cloud-trigger`, and supports split per-role Deployments (api, scheduler, worker, consumer) or a single one. `demo.*` adds throwaway Postgres, LocalStack and Kafka. Helm isn't installed locally; run it through `docker run --rm -v "$PWD:/apps" -w /apps alpine/helm:3.19.0 lint cloud-trigger`. Verify chart changes with `helm lint` plus `helm template`, in both modes.
