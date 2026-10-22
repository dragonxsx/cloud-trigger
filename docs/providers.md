# Writing a provider

A job has four pluggable parts. Each is a **provider**, identified by a `type` string:

| Kind       | Answers                            | Built-ins                                                             | Contract                                                                              |
| ---------- | ---------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `trigger`  | When does it run?                  | `cron`, `interval`, `once`, `rrule`, `manual`, `after_job`, `webhook` | `nextFireAt(config, ctx) → Date \| null`; event triggers add `matches(config, event)` |
| `input`    | What payload does it send?         | `static`, `template`, `event`                                         | `resolve(config, ctx) → Payload`                                                      |
| `target`   | Where does it go, and did it work? | `http`, `graphql`, `fanout`                                           | `execute(config, request) → TargetResult`                                             |
| `notifier` | Who hears about the outcome?       | `webhook`, `slack`, `email`                                           | `notify(config, event, ctx) → NotifyResult`                                           |

The config is a **zod schema**, and it is the single source of truth:

- The server validates configs with it on save. Errors come back to the UI per field.
- The API publishes it as JSON Schema (`GET /api/providers`), and the UI renders a form from it. No frontend code is needed for a new provider.
- Fields wrapped in `secret(...)` are redacted in API responses. Clients can send the redacted value back unchanged and the stored secret is kept. This also works for record values (`z.record(z.string(), secret(z.string()))`). Use it for credential maps such as the HTTP target's `secretHeaders`.

## Plugin packages in this repo

Integrations with heavy SDKs live in their own workspace packages. Each one exports a `ProviderPlugin` (named and as the default export). A plugin may implement `dispose()` to close pooled clients; the server calls it on shutdown. Registering a plugin whose `name` is already loaded is a no-op. Provider types are not deduplicated: a plugin that registers a `type` already taken in the same kind fails startup. The server registers them statically, and they can also be loaded through `PLUGINS=`.

| Package                          | Targets                     | Event sources |
| -------------------------------- | --------------------------- | ------------- |
| `@cloud-trigger/providers-grpc`  | `grpc`                      |               |
| `@cloud-trigger/providers-aws`   | `sqs`, `sns`, `eventbridge` | `sqs`         |
| `@cloud-trigger/providers-kafka` | `kafka`                     | `kafka`       |
| `@cloud-trigger/providers-nats`  | `nats`                      | `nats`        |

Each of these packages also registers a connection type: `grpc`, `aws`, `kafka` and `nats`. The builtin package registers `http`, `slack` and `smtp`.

## Connections

A **connection** is the one abstraction for every external service: a saved, typed record of where the service is and how to authenticate to it, such as a base URL and an OAuth client, brokers and SASL credentials, a Slack webhook, or an SMTP server and sender. It also holds named **endpoints** of three kinds:

- a complete target config that runs over the connection (`{ key, target }`: `billing/charge` is `POST /charges` on the `billing` connection);
- a complete event-source config that consumes over it (`{ key, source }`: `events/orders` is the `orders` topic with its consumer group);
- a complete notifier config that sends over it (`{ key, notifier }`: `mail/oncall` is an email to the on-call list with a fixed subject).

A job references them as `target.connection`, `trigger.connection` or `notifications[].notifier.connection`, each `{ key, endpoint? }`; group default notifications do the same. Each reference can only use endpoints of its own kind.

- With an endpoint, the referencing `config` is a JSON merge patch (RFC 7386) over the endpoint's config: set a field to override it, or to `null` to drop it. `type` must match the endpoint's type.
- Without an endpoint, the config is a full config that runs over the connection.
- Without a connection, targets, event sources and notifiers work as before, with the connection fields inline.

Jobs reference connections by **key**, not by id. Keys are lowercase slugs and never change. An exported job therefore imports into another deployment unchanged, and staging and production can each define their own `billing`.

One deployment can also serve several **environments**. An environment is a saved record (`{ key, name, description }`, keyed by a slug, under Settings → Environments). A connection can carry one **overlay** per environment: `{ environment, config?, endpoints: [{ key, config }] }`.

- `config` is a JSON merge patch over the connection's config, and each `endpoints[].config` is a merge patch over that endpoint's provider config. `null` drops a field.
- A job, group or workflow can set `environment`. The job's own environment wins over its group's. A workflow passes its environment to inline steps that set none, and steps that reference an existing job keep that job's environment.
- When a connection has no overlay for the environment, or the job has no environment at all, the base config is used.
- Overlays are applied when the catalog is built: `loadConnections(repository, refs, environment)` returns `inEnvironment(catalog, environment)`, which uses `overlayConnection` from core. Resolution (`resolveTarget`, `resolveTrigger` and `resolveNotifier`) stays the same.
- A queued notification pins the environment it was enqueued with (`NotificationDelivery.environment`).
- Saving a connection validates every overlay as its own config. Saving a job, group, workflow or connection rejects an unknown environment. An environment that is still in use can't be deleted.
- Secrets in overlays are redacted and restored like the base config: overlays are matched by environment, and endpoint patches by key.

A connection type is a provider of kind `connection`:

```ts
export const billingApi = defineConnection({
  type: 'billing',
  displayName: 'Billing API',
  configSchema: z.object({ baseUrl: z.url(), apiKey: secret(z.string()) }),
  async test(config, { secrets, signal, now }) {
    // Reachability and credentials, for the "Test connection" button.
    return ok({ message: 'Reachable' });
  },
});
```

A target or event source opts in in one of these ways:

- **`defineConnectedTarget({ connection: billingApi, check?, execute })`** for targets whose request fields differ from the connection's, as with `http`, `graphql` and `grpc`. `execute` receives `request.connection: { key, version, config } | undefined`, typed from the connection's schema. Use `check(config, connection)` for rules that depend on the connection; for example, `http` requires a relative `url` with a connection and an absolute one without, so a connection's credentials never reach another host. Set `connectionRequired: true` to refuse inline use.
- **`defineInlineConnectedTarget({ connection, execute })`** for targets that already embed the connection's fields at the top level of their config, as `sqs`, `sns`, `eventbridge`, `kafka` and `nats` do (spread `ConnectionSchema.partial().shape` into the target schema). `request.connection` is always set: it comes from the saved connection, or else is parsed from the inline fields. Setting an inline connection field while a connection is used is a config error, so there is one source of truth.
- **`defineInlineConnectedEventSource({ connection, exclusive, subscribe, describe })`** for queue consumers, which embed the connection's fields the same way (`sqs`, `kafka`, `nats`). `subscribe(config, ctx)` receives `ctx.connection: { key, version, config }`, from the saved connection or parsed from the inline fields. Build the broker client from `ctx.connection.config`, never from the trigger config.
- **`defineConnectedNotifier({ connection, check?, notify })`** and **`defineInlineConnectedNotifier({ connection, notify })`** are the notifier counterparts of the two target helpers. `notify(config, event, ctx)` receives `ctx.connection`. The `webhook` notifier uses the separate form over `http` (a relative `url` with a connection, so it gets the base URL, auth, headers and signing); `slack` and `email` embed the `slack` (`url`) and `smtp` (`host`, `port`, `secure`, `user`, `password`, `from`) fields inline.

The engine resolves references with `resolveTarget`, `resolveTrigger` and `resolveNotifier` (each `(registry, ref, catalog)`) from core, on save and again on every run, so a connection change reaches the next run. The notification dispatcher resolves the notifier's connection on every delivery attempt, so a rotated credential also reaches pending retries. The consumer supervisor resubscribes an event source when its connection's version changes. It reports problems at `target.connection.key`, `target.connection.endpoint`, `target.type` and `target.config.*` (and the same under `trigger.` and `notifications.<i>.notifier.`). A target whose config contains other targets (as `fanout` does) implements `connectionRefs(config)`, so the engine loads and tracks those connections too, and binds its children with `resolveTarget` and the `connections` catalog passed to `execute` and `check`.

`ConnectionService` validates every endpoint against its connection on save (a source endpoint must name an event-source trigger). It refuses an update that would break a job's trigger, target or notifications, or a group's default notifications, and refuses to delete a connection while any job or group uses it (`connection_in_use`, HTTP 409). `GET /api/connections/{key}/usages` lists both. The worker adds `metadata.connection = { key, endpoint, version }` to each result.

Secrets work as they do in job configs: mark fields with `secret()` and resolve `{{secret:NAME}}` at execution time. The `http` connection caches OAuth 2.0 client-credentials tokens per connection version and credentials, and refreshes them 30 seconds before they expire.

The `http` target's `url` may contain `{name}` path parameters, filled from `pathParams` (URL-encoded; values may contain `{{secret:NAME}}`). An endpoint can leave a value empty, and a job sets it with a merge patch such as `{ "pathParams": { "id": "42" } }`. A run whose path parameter is still empty fails with `missing_path_param` and is not retried.

### Importing endpoints from OpenAPI

An `http` connection can generate its endpoints from an OpenAPI 2.0 to 3.2 document (JSON or YAML), via **Import from OpenAPI** in the connection form or `POST /api/connections/openapi/preview`.

- **Preview only.** The route saves nothing. It returns the API info, absolute `servers`, a suggested `auth` without secrets, one `ImportedOperation` per operation (a ready `TargetEndpoint` draft) and structured `warnings`. The UI merges the chosen operations into the form, and saving the connection runs the usual `ConnectionService` validation.
- **Mapping** (`@cloud-trigger/openapi`, `analyzeOpenApi`):
  - Swagger 2.0 and 3.0 are upgraded to 3.1 with `@scalar/openapi-parser`.
  - Keys come from `operationId`, the summary, or method and path, are slugified and de-duplicated with `-2` suffixes.
  - The path becomes `url` (with an optional prefix). Path parameters become `pathParams`. Required query and header parameters are added with their example or default value.
  - With `bodies: "example"`, a JSON body is taken from the media type's example or sampled from its schema (`openapi-sampler`, bounded depth).
  - Security schemes map to `bearer`, `basic`, `api_key` or `oauth2_client_credentials` auth.
  - Cookie parameters, non-JSON bodies, `TRACE`, `QUERY` and custom methods, per-operation servers and duplicate operation ids produce warnings, never a failed import.
- **Re-import** (`classifyOperations` and `planEndpointImport` in core): an operation matches an existing `http` endpoint by method plus normalized path (`GET /pets/{}`), so a renamed path parameter still matches. A match is `unchanged`, or `changed` with a per-row choice:
  - **update** keeps the key, the name, user-set values and other fields. The spec sets `method` and `url`, and adds new parameters.
  - **keep_both** adds a copy under a fresh key.
  - **skip** leaves the endpoint alone.
  - The import never removes an endpoint, and the 200-endpoint limit still applies.
- **Security.** Only local `#/` references are resolved; external `$ref`s (files or URLs) are reported, never followed. YAML aliases are capped, and documents are limited to 5 MB and 2,000 operations. A URL source is fetched by the server through `SpecFetcher` (`apps/server/src/infra/http/spec-fetcher.ts`), which refuses non-public addresses (checked on every DNS lookup and redirect, at most 3) unless `OPENAPI_FETCH_ALLOW_PRIVATE=true`. Errors name the problem, never the network detail.

### Extracting a connection from a job

**Extract connection** on the job page (`POST /api/jobs/{id}/extract-connection`) moves one inline slot (the target, the trigger or a notification rule's notifier) onto a new connection with one endpoint. It then rewires the slot to `{ connection: { key, endpoint }, config: {} }`. `dryRun` defaults to `true`, and the response redacts secrets.

- **The provider hook.** A provider opts in with `extractConnection(config, raw, { baseUrl })` on `defineConnectedTarget` or `defineConnectedNotifier`. The hook returns `{ connection, config, suggestedName?, warnings? }`: the connection config, and the endpoint config that is left over. The inline helpers (`defineInlineConnected*`) get this for free: their `connectionFields` move to the connection and everything else stays in the endpoint, which mirrors `bindInlineConnection`. Report problems with the `baseUrl` option at the path `BASE_URL_OPTION`. `ProviderInfo.extractsConnection` tells the UI which slots qualify.
- **What moves.**

  | Provider                     | Moves to the connection                                                                                                                          | Stays in the endpoint                  |
  | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
  | `http`, `graphql`, `webhook` | `baseUrl` (the scheme and host, or a `baseUrl` prefix you choose), `secretHeaders`, `signing`, and plain headers that clash with a secret header | the relative `url` and everything else |
  | `grpc`                       | `address`, `tls`, `secretMetadata`                                                                                                               | everything else                        |

- **Same requests.** The core builder (`extractJobConnection`) resolves both the old slot and the rewired one before anything is saved. The engine (`ConnectionExtractor`) validates the draft connection and the rewired job together (`JobService.validate` takes draft connections), then creates the connection and updates the job in one unit of work. On Mongo, which is not atomic, a failed job update deletes the new connection again.
- **Caveats** come back as `warnings`:
  - a query string in the URL is re-encoded by `URLSearchParams` when it is joined to the base URL;
  - an event-source trigger reconnects once.
- **Refusals:** a URL that is not a literal `http(s)://…` (such as `{{secret:URL}}` on its own), a host or base URL with `{name}` path parameters, a split that would drop a trailing slash or collapse repeated slashes when joined back, a `#fragment`, a slot that already uses a connection, and a job owned by a workflow. `{{secret:…}}` inside the host is fine.
- **Hints.** Existing connections of the same type are listed as `identical` (the same config, with secrets redacted, so secret values are never compared) or `same_address`, which uses the connection definition's optional `address(config)` hook.

## Example: an SQS target

This is a simplified version of the real `sqs` target in `packages/providers-aws`. The real one adds FIFO deduplication by the run's idempotency key, static credentials, a LocalStack endpoint, and message attributes. A provider's `type` must be unique per kind across the built-ins and every loaded plugin, or startup fails with `Duplicate <kind> provider "<type>"`, so the example uses `acme_sqs`.

```ts
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  abortedResult,
  defineTarget,
  failedResult,
  secret,
  toError,
  type ProviderPlugin,
} from '@cloud-trigger/core';
import { z } from 'zod';

const sqs = defineTarget({
  type: 'acme_sqs',
  displayName: 'Amazon SQS (Acme)',
  description: 'Sends the payload as an SQS message.',
  configSchema: z.object({
    queueUrl: z.url(),
    region: z.string().default('us-east-1'),
    messageGroupId: z.string().optional(),
    accessKeyId: secret(z.string()).optional(),
  }),
  async execute(config, { payload, ctx, signal }) {
    const started = performance.now();
    try {
      const client = new SQSClient({ region: config.region });
      const out = await client.send(
        new SendMessageCommand({
          QueueUrl: config.queueUrl,
          MessageBody: payload.body ?? '',
          MessageGroupId: config.messageGroupId,
        }),
        { abortSignal: signal },
      );
      return {
        outcome: 'success',
        durationMs: performance.now() - started,
        metadata: { messageId: out.MessageId },
      };
    } catch (error) {
      const durationMs = performance.now() - started;
      if (signal.aborted) return abortedResult(signal, durationMs);
      return failedResult('sqs_error', toError(error).message, true, durationMs);
    }
  },
});

export const plugin: ProviderPlugin = {
  name: '@acme/ct-provider-sqs',
  register: (r) => r.register(sqs),
};
```

`config` in `execute` is fully typed from the schema, so no casts are needed. `failedResult` and `abortedResult` build failure results with the engine's error codes.

Install the package next to the server and enable it with `PLUGINS=@acme/ct-provider-sqs`.

## Event triggers

Event triggers never schedule on their own: `nextFireAt` is always `null`. There are three kinds.

**Run events.** `defineEventTrigger({ type, configSchema, matches, upstream, describe })`. The engine calls `matches(config, event)` when a run finishes (`{ kind: 'run_finished', jobId, runId, status }`). `upstream(config)` returns `{ jobId, path }` edges. The engine validates them on save (no self-references, no cycles), stores them on the job, and uses them to find dependants. A matching event inserts a `reason: 'chained'` run, and its `RunContext.parent` carries the upstream run's job, status and result. The built-in `after_job` trigger is an example.

**Inbound webhooks.** An event trigger that also implements `inbound(config, request, ctx)` can be called at `POST /hooks/{jobId}/{token}`. It returns `{ accepted: true, deliveryId, perSecond? }` or `{ accepted: false, reason }`. A wrong token answers 404, so job ids aren't revealed. The built-in `webhook` trigger checks the token (a `secret()`, compared in constant time), optionally verifies an HMAC signature, and uses the `Idempotency-Key` header (configurable) as the delivery id. Without that header, it hashes the timestamp and body. Deliveries are rate-limited per job through the `RateLimiter`, using the trigger's `rateLimit` or `WEBHOOK_MAX_PER_SECOND`.

**Queue consumers.** `defineEventSource({ type, configSchema, exclusive, subscribe(config, ctx), describe })` defines a long-lived listener. `subscribe` runs until `ctx.signal` aborts. It must call `await ctx.emit({ id, body, headers })` for each message and acknowledge or delete the message only after `emit` resolves; `emit` throws if the run could not be queued, so the broker redelivers. Set `exclusive: true` when the broker can't share the work, as with SQS: only the replica holding the job's lease subscribes. Kafka consumer groups and JetStream durable consumers set it to `false`, so every consumer replica subscribes. The built-ins are `sqs` (providers-aws), `kafka` (providers-kafka) and `nats` (providers-nats, JetStream). All three run over their `aws`, `kafka` and `nats` connections (`defineInlineConnectedEventSource`, see **Connections**).

Both webhooks and queue messages insert a `reason: 'event'` run with the idempotency key `event:<jobId>:<deliveryId>`, so redeliveries run once. The request or message is stored on the run as `event` (`{ kind, source, id, body, headers, receivedAt }`, body at most 256 KiB) and reaches providers as `ctx.trigger.event`. The `template` input exposes it as `{{ event.body.foo }}`, with the body parsed when it is JSON, and the `event` input forwards the body unchanged.

## Testing a target

Every target must pass `describeTargetContract(provider, harness)` from `@cloud-trigger/testing`. The suite checks:

- success against a healthy endpoint, and that `ctx.traceparent` is forwarded (when the harness can observe it)
- the `retryable` flag on transient and on permanent failures
- that `AbortSignal.timeout` reports a retryable `timeout`, and that cancellation reports a non-retryable `cancelled`
- that every `secret()` path is redacted
- that an invalid config is rejected with issues

Set the harness's `connection: () => ({ key, version, config })` to run the same suite over a connection, as the `http` and `grpc` targets do.

`startTestHttpServer(handler)` gives you a local endpoint for the slow, failing and rejecting cases. For SDK-based targets, point the SDK `endpoint` at it.

## Tracing and delivery keys

`RunContext.traceparent` holds the W3C trace context of the run's span when tracing is on. Forward it in your protocol's headers or attributes so downstream services join the trace. `deliveryKey(ctx)` returns the run's idempotency key, or its id when there is none. Use it as the broker's deduplication id, as SQS FIFO `MessageDeduplicationId` and JetStream `msgID` do.

## Rules for well-behaved providers

- **Respect `signal`.** It fires on timeout and on cancellation (API cancel, or the `replace` overlap policy). The engine stops waiting either way, but an abandoned call keeps holding sockets.
- **Return failures as values.** Set `retryable` correctly. The engine retries only failures marked retryable, and only up to the job's retry policy.
- **Resolve secrets at execution time** with `ctx.secrets.interpolate()` or `ctx.secrets.get()`, never at bind time.
- **Keep `nextFireAt` pure and deterministic.** The scheduler calls it repeatedly during catch-up and preview.
- **Read time from `ctx.now`**, never `Date.now()` or `new Date()`. `RunContext` and the trigger `lint` context both carry it, so tests can control it.
- **Notifiers return `NotifyResult`** (`ok()` or `err({ message, retryable })`). The dispatcher retries retryable failures with backoff up to `NOTIFY_MAX_ATTEMPTS`, and a thrown error counts as retryable. Delivery is at least once: a dispatcher that dies after sending but before recording the delivery causes a redelivery. Pass `event.idempotencyKey` to the receiver (the webhook notifier sends it as `Idempotency-Key`) so it can drop duplicates.
- **Cover the provider with tests:** see `packages/providers-builtin/src/**/*.test.ts`.
