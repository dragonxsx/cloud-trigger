---
paths:
  - 'packages/api-contract/**'
  - 'apps/server/**'
---

# API (`packages/api-contract` + `apps/server`)

- **Contract first with oRPC.** Add routes to `packages/api-contract/src/contract.ts`, using schemas from `schemas.ts` or core.
  - Start every route from `base` (read scope) or `write`, so the typed errors and the `meta.minimumScope` come along.
  - Use `.meta({ minimumScope: 'admin' })` (the `admin` builder) for admin-only routes, and `.meta({ minimumScope: 'read', public: true })` for the rare route that needs no credentials.
  - Nest registers routes in contract key order. Declare static paths such as `/jobs/export` **before** `/jobs/{id}`, otherwise the parameterised route captures them.
  - Non-JSON endpoints (badges, iCal, inbound webhooks at `/hooks`) are plain Nest controllers outside `/api`; add their paths to the `ServeStaticModule` exclude list and to the Vite dev proxy.
  - Query params are strings: use `QueryDate` for dates and `commaSeparated(schema)` for arrays.
- **Implement in NestJS** in the feature folder `apps/server/src/api/<feature>/`. Write the handlers as `<feature>Handlers(deps)` in `<feature>.router.ts`, built from the injected `ORPC_API` (the `createApi` implementer that carries the auth and scope middleware). Give the router class one `factoryProvider` in `<feature>.module.ts`. A feature has no controller of its own: `ApiController` (`api/api.controller.ts`) implements the whole contract with `@Implement(contract)` from the composed `ApiRouter`. A new contract namespace therefore needs an entry in `composeAppRouter` (`api/app-router.ts`) and its module in `ApiModule`. The router providers stay separate from Nest controllers because MCP and setup mode reuse them, and controllers can't be injected.
  - `ORPCModule.forRoot` must keep `context: {}` and the `RequestHeadersPlugin`, which adds `reqHeaders` to that context per request.
  - Nest's body parser stays off (`bodyParser: false` in `main.ts`), because oRPC parses request bodies itself (bracket notation, files).
- Redact provider configs in **every** response that contains a job (`JobRedactor`). Connections go through `redactConnection` and `restoreConnection` on the same class (overlays included), and `connections.test` restores `***` from the saved connection when given its `key`.
- The MCP server (`apps/server/src/mcp`) calls the oRPC router in-process through the `ApiRouter` provider (`api/app-router.ts`), which composes the same router providers `ApiController` serves over HTTP. Its tools come from the contract: to expose a route to agents, give it `.meta(readTool({ name, description }))` or `.meta(writeTool({ … }))` in `contract.ts`, and don't edit `mcp-server.ts`. `contract-tools.ts` turns every procedure with `meta.mcp` into a tool. The input JSON Schema comes from the same `ZodToJsonSchemaConverter` that OpenAPI uses, the tool's scope is `minimumScope`, and read tools get `readOnlyHint`. Keep the tool list small and task-shaped (about 20 or fewer); not every route should be a tool.
  - Tool calls bypass the MCP SDK's zod parsing (they use the low-level `tools/list` and `tools/call` handlers) and pass the raw arguments to oRPC `call()`. Otherwise transforms such as `QueryDate` would run twice. A procedure that streams (`eventIterator`) cannot be a tool, and startup throws if it is marked as one.
- OpenAPI is generated from the contract, at `/api/openapi.json`, with Scalar docs at `/docs`. Don't add `@nestjs/swagger` or `nestjs-zod`; neither supports Nest 12 or TS 7.
- Tracing is the OpenTelemetry Node SDK, started by `startTracing` when `OTEL_EXPORTER_OTLP_ENDPOINT` is set; the SDK reads the other `OTEL_*` variables itself.
- **Auth and setup.** Sign-in settings (`AuthSettings`), users and API keys live in the database behind the core `authSettings`, `users` and `apiKeys` ports; there are no auth env vars.
  - `Authenticator` reads settings through `AuthSettingsCache` (5 s TTL; a local write updates it at once, other replicas within 5 s). It returns `'setup_required'` until the wizard has run, which the API maps to `SETUP_REQUIRED` (503).
  - Password sessions are HS256 JWTs (`iss: cloud-trigger`) signed with `AuthSettings.sessionSecret`. A user's `tokenVersion` is in the token; bump it to sign that user out, and rotate the secret to sign everyone out. Any other bearer token goes to OIDC.
  - Business rules (last-admin guard, login throttling, setup completion) live in `AccessService` (`src/auth/access-service.ts`). Lockout rules are the pure `validateAuthMethods` in core.
  - The setup stage comes from two places. `main.ts` probes the env DB config and serves `SetupAppModule` (only `setup.*`, health and the web UI) while there is no usable database. With a database, `AppModule` serves `setup.*` until `AuthSettings` exists. Both implement the routes with `setupHandlers` and a different `SetupBackend`.
  - E2E tests seed auth through `createTestApp(config, { auth })`. The default grants anonymous `admin`; pass `{ apiKeys: [...] }` for scoped keys, or `auth: false` to exercise the wizard.
- Fetch a user-supplied URL from the server only through `SpecFetcher` (`apps/server/src/infra/http/spec-fetcher.ts`), which refuses non-public addresses on every DNS lookup and redirect. Never follow external `$ref`s in user documents; `@cloud-trigger/openapi` resolves local `#/` references only.
- Health is at `/health/live` and `/health/ready`, and metrics at `/metrics` (`@prometheus-io/client`, because prom-client is deprecated).
- Configuration lives in the zod env schema in `apps/server/src/config/config.ts` and follows 12-factor. Document new variables in `.env.example`, the Helm `values.yaml` and its `templates/config.yaml`.
- E2E tests (`apps/server/test/*.e2e.test.ts`) use the typed client `JsonifiedClient<ContractRouterClient<Contract>>` over `OpenAPILink`. Pass dates as ISO strings.
- Server tests that need Mongo end in `.mongo.test.ts` and run in the `mongo` Vitest project, which shares one container through `test/support/global-mongo.ts`; get its env with `mongoEnv(name)`. Every other server test runs in `unit` and needs no container unless it starts one itself.

## Server modules (`apps/server`)

- One NestJS module per feature, following Nest's feature-module layout:
  - Infra modules are `@Global()` and imported once by `AppModule`: `ConfigModule`, `LoggingModule`, `TelemetryModule`, `PersistenceModule` and `ProvidersModule` (the registry, secrets and clock).
  - `EngineModule` exports the engine services (`JobService`, `WorkflowService`, …, and `RUN_LISTENERS`). `RuntimeModule` builds the role-gated loops (`createBackgroundLoops`) inside `EngineRuntime`.
  - `ApiModule` holds the oRPC features under `api/<feature>/`, the single `ApiController` that serves them, plus `ApiSharedModule` (`ORPC_API`, `JobRedactor`). `FeedsModule`, `HooksModule`, `McpModule`, `HealthModule` and `WebModule` hold the plain controllers.
  - `AppModule.forRoot({ config, pino, tracer? })` only composes these modules. It is the one place that gates them by `APP_ROLE`.
- **Typed DI** lives in `src/common/tokens.ts`:
  - Interfaces get a `token<T>(name)`; engine and server classes are their own tokens.
  - Register every provider with `factoryProvider(provide, [deps…], (…deps) => value)`, which type-checks the factory's parameters against the inject list. Don't write raw `{ provide, useFactory, inject }` objects. For third-party `forRootAsync`, spread `factory([deps…], fn)`.
  - Constructors (controllers only) inject **class** tokens with an explicit `@Inject(Class)`. A controller that needs an interface value gets it through a small class built by a factory, such as `Readiness` or `FeedsService`; that keeps every injection site typed. Don't rely on `emitDecoratorMetadata`, because `import type` erases it.
  - Tests read a token with `resolveToken(app, TOKEN)`. Boot the app with `createTestApp(config)` in `test/support/app.ts`.
- Lifecycle:
  - `EngineRuntime` starts loops in `onApplicationBootstrap` and stops them in `beforeApplicationShutdown`.
  - Resources close through a `ShutdownHook` provider in `onApplicationShutdown`.
  - Nest aborts the process when a provider factory throws during startup; test apps pass `abortOnError: false` so a failing boot (such as a wrong encryption key) rejects instead.
  - Nest finishes every `beforeApplicationShutdown` before any `onApplicationShutdown`, so loops always stop before the DB closes. Nest also calls these hooks on objects returned by factories.
- `SetupController` exists only for setup mode (`SetupAppModule`); don't add it to `SetupModule`, or `/api/setup/*` is registered twice.
