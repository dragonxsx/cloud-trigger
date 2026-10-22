---
paths:
  - 'packages/providers-*/**'
  - 'packages/core/**'
---

# Providers (extensibility)

The full guide, with an SQS example, is in `docs/providers.md`. In short:

- Define a provider with `defineTrigger`/`defineEventTrigger`/`defineInput`/`defineTarget`/`defineNotifier({ type, displayName, configSchema, … })`. The config type is inferred from the schema.
- Event triggers declare their upstream edges with `upstream(config)`. The engine stores them as `Job.upstreamJobIds`, so persistence never queries provider-specific config.
- `.meta({ widget: 'job' })` on a string field renders a job picker in the UI.
- The registry stores `bind(raw) → Result<Bound*, ConfigError>`, so callers never see the config type and never cast.
- Mark sensitive fields with `secret(z.string())`. The API then redacts them as `***` (`redactBySchema`), and when a client sends `***` back, the stored value is kept (`restoreRedacted`).
- Secret fields are also encrypted at rest. `sealedPersistence` (engine) wraps the adapters at the composition root: writes seal every `secret()` value (walked with `SecretFields`, which also drives API redaction) through the `SecretCipher` port, and reads open every `ctenc:v1:` string, then re-parse the entity. The engine, providers and API only ever see plaintext; adapters only ever see ciphertext. A new repository method that returns or writes a job, connection, group, workflow, workflow run, delivery or auth settings must be added to `sealedPersistence` (its explicit object literals make the compiler ask). Only `resealSecrets` reads the unwrapped persistence.
- Resolve `{{secret:NAME}}` at execution time through `ctx.secrets`, never at bind time.
- Reusable addresses and credentials are **connections** (`defineConnection`). Targets opt in with `defineConnectedTarget` (separate request fields, as `http` does) or `defineInlineConnectedTarget` (connection fields embedded at the top level, as `sqs` does); queue consumers opt in with `defineInlineConnectedEventSource`; notifiers with `defineConnectedNotifier` (`webhook`) or `defineInlineConnectedNotifier` (`slack`, `email`). Resolve job targets, triggers and notifiers only through `resolveTarget`, `resolveTrigger` and `resolveNotifier` from core (or `bindNotifications` in the engine), never by hand: they handle connection keys, endpoints and merge-patch overrides. A target that nests other targets reports their references with `connectionRefs(config)`. See `docs/providers.md`.
- Give union members and fields `.meta({ title, description })`. The UI renders forms from `z.toJSONSchema`, so a new provider needs **no frontend code**.
- Respect `AbortSignal`, return failures as values with a correct `retryable` flag, and keep trigger math pure and deterministic.
- Wall times inside a DST spring-forward gap fire just after it (02:30 becomes 03:30), as cron does.
- Built-ins go in `packages/providers-builtin/src/<kind>s/`. Heavy or optional SDKs (gRPC, AWS, Kafka) go in their **own package** `packages/providers-<name>`, exported as a `ProviderPlugin`. They are loaded statically, or through the `PLUGINS` env var.
