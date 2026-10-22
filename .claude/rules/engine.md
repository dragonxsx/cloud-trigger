---
paths:
  - 'packages/engine/**'
---

# Engine (`packages/engine`)

- The engine is free of any framework. Its classes (`Scheduler`, `Worker`, `Reaper`, `JobService`) take a `deps` object made of ports, registry, clock and logger, plus an `options` object.
- Loops extend `PollingLoop` (`loop.ts`).
- Persistence writes use **CAS** (`RunRepository.transition(previous, next)`). Handle `stale_run` by dropping the work, because another replica won. Never overwrite.
- Exactly-once firing relies on the idempotency key `sched:<jobId>:<iso>` and its unique partial index. Any new run source (backfill, chaining, events) must use a deterministic idempotency key too. Runs are pruned and expire, so a source that can repeat an old occurrence (like backfill) inserts with `runs.insert(run, { durableKey: true })`, which keeps the key in `fire_keys`.
- Tracing goes through the core `Tracer` port, never `@opentelemetry/*` in the engine or providers. Targets forward `ctx.traceparent` in whatever header or attribute their protocol has, and `describeTargetContract` checks it when the harness can observe it.
- Side effects go through `RunLifecycleListener` (`lifecycle.ts`): `onRunFinished`, `onAttemptFailed` (a retry is pending) and `onRunLate`. Metrics, notifications and chaining all use it.
- Idempotency keys in use: `sched:`, `manual:`, `chain:<parentRunId>:<childJobId>`, `backfill:<jobId>:<iso>`, `event:<jobId>:<deliveryId>` (webhooks and queue messages, inserted with `durableKey`), `wf:<workflowRunId>:<node>` (workflow node runs, durable) and `wfsched:<workflowId>:<iso>` (scheduled workflow runs, unique on `workflow_runs`), and for the outbox `notify:<runId>[:<attempt>]:<event>:<ruleIndex>`.
- Event runs (`reason: 'event'`), workflow node runs (`reason: 'workflow'`) and backfill runs wait under the `forbid` overlap policy instead of being skipped, so no delivered message is dropped.
- Inbound events go through `EventIngestor` (`ingest` for queue messages, `receiveWebhook` for `/hooks`). Event sources run under `ConsumerSupervisor` (`APP_ROLE=consumer`). Exclusive sources hold an `EventSourceLeases` lease keyed `source:<jobId>`. A source must call `emit` and acknowledge the message only after `emit` resolves; `emit` throws when the run could not be queued.
- Notifications are enqueued into the `NotificationOutbox` and sent by `NotificationDispatcher`; never call a notifier inline. Delivery is at least once, and receivers dedupe on the idempotency key. A delivery stores the notifier reference, not a resolved config: the dispatcher loads its connection and resolves it on every attempt, so resolved secrets never land in the outbox.
- Don't CAS-replace a running run from anywhere except its worker; it would break the worker's final CAS. Fenced field updates that leave `updatedAt` and the lease alone are fine (`updateSla`, `markSlotHeld`, `acquireExecution`). `transition` keeps `late` and `lateReasons` when it replaces a document.
- Workflow state changes go through `WorkflowRuntime.mutate`: a pure transition from `domain/workflow-run.ts`, a CAS write (`WorkflowRunRepository.update(next, expectedVersion)`), and then its effects. Never write a `WorkflowRun` any other way. Jobs with `workflowId` set belong to their workflow; change them only through `WorkflowService`.
- Bind a job with `bindJob(registry, spec, catalog)`, loading the catalog with `loadConnections(connections, job.connectionRefs, environment)` first, where `environment` comes from the resolved policy. Code that only needs the schedule calls `loadTrigger(registry, connections, job)` (or `bindTrigger` with a catalog it already holds), so a broken target never blocks explain, resume or backfill. The `ConsumerSupervisor` keys each subscription by the job version, its trigger connection's version and the effective environment.
- Record non-routine scheduling decisions (skips, catch-ups, pauses, throttling) with `DecisionRecorder`, so the explainer can narrate them.
- Integration tests go in `packages/engine/test/*.integration.test.ts` and run against real Mongo plus a real local HTTP server.
- Plugin tests use Testcontainers too. LocalStack is pinned to `localstack/localstack:4.14`, because later images refuse to start without a `LOCALSTACK_AUTH_TOKEN`. Override the image with `LOCALSTACK_IMAGE`.
