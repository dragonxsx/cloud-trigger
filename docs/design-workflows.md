# Design: DAG workflows and approval gates

Status: **implemented** · Date: 2026-10-18. Read `docs/conventions.md` first.

This is a design record. Where it and the code disagree, the code wins; update this file or mark the section superseded.

## Goals

- Run several jobs as one unit, ordered by a directed acyclic graph. Edges are conditioned on the upstream outcome.
- Pause a workflow at an **approval gate** until someone with write scope approves or rejects it. A gate can have a timeout that fails it.
- Reuse the run model. Every job node executes as an ordinary run, so retries, timeouts, overlap, rate limits, SLAs, notifications and history all keep working.
- Exactly-once node execution across replicas, with no new locking primitive.

Non-goals: loops, dynamic fan-out, passing data between nodes beyond `{{ parent.* }}`, and sub-workflows.

## Model (`packages/core/src/domain/workflow.ts`)

```ts
WorkflowNode =
  | { key, label?, kind: 'job',      jobId: JobId }              // reference an existing job
  | { key, label?, kind: 'inline',   job: InlineJobSpec }        // a job owned by the workflow
  | { key, label?, kind: 'approval', timeoutMs?: number }        // a gate
WorkflowEdge = { from: key, to: key, on: 'succeeded' | 'failed' | 'any' }   // on defaults to 'succeeded'
WorkflowSpec = { name, description, enabled, nodes, edges, schedule: TriggerRef | null }
Workflow     = WorkflowSpec & { id: WorkflowId, nextFireAt, version, createdAt, updatedAt }
```

- `validateWorkflow(spec)` is pure and unit-tested. Keys must be unique slugs, and edges must reference existing nodes, with no self-edges, duplicate edges or cycles (Kahn's algorithm). There must be at least one node. It returns `ConfigError` issues with field paths (`nodes.2.key`, `edges.0.to`).
- **Inline nodes** carry a `JobSpec` without a trigger. `WorkflowService` turns each one into a regular job owned by the workflow (`Job.workflowId`) with the built-in `manual` trigger, which never fires on its own. They are created, updated and deleted together with the workflow, so the worker, history and analytics need nothing new. Owned jobs can't be edited or deleted directly (`CONFLICT`).
- `schedule` is any time trigger (cron, interval, rrule, once). Event triggers are rejected. `nextFireAt` is derived from it the same way it is for jobs.

## Runs (`packages/core/src/domain/workflow-run.ts`)

```ts
NodeStatus =
  'pending' | 'queued' | 'waiting_approval' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';
NodeState = {
  status,
  runId: RunId | null,
  deadline: Date | null,
  decidedBy: string | null,
  reason: string | null,
  finishedAt: Date | null,
};
WorkflowRun = {
  id,
  workflowId,
  workflowName,
  workflowVersion,
  status: 'running' | 'succeeded' | 'failed' | 'cancelled',
  reason: 'manual' | 'scheduled',
  idempotencyKey: string | null,
  graph: { nodes, edges }, // snapshot, so later edits never change a running instance
  nodes: Record<key, NodeState>,
  startedAt,
  finishedAt,
  version,
  createdAt,
  updatedAt,
};
```

All transitions are pure functions that return the next `WorkflowRun` plus a list of **effects** (`{ type: 'start_job', key, runId, jobId }` and `{ type: 'cancel_run', runId }`). The engine applies the effects after a successful CAS write.

- `startWorkflowRun(workflow, { id, reason, now, key })`: roots become ready.
- `completeNode(run, key, outcome, now)`: called when a node's run finishes, after its retries are exhausted.
- `decideApproval(run, key, { approved, by, now })`, `expireApprovals(run, now)`, `cancelWorkflowRun(run, now)`.
- **Readiness** (shared by all of them): a `pending` node with all its sources terminal is
  - _ready_ if every incoming edge is satisfied (`succeeded` matches `succeeded`/`any`, `failed` matches `failed`/`any`; `skipped` and `cancelled` satisfy nothing);
  - otherwise _skipped_, which propagates down the graph.
    A ready job node becomes `queued` with a pre-generated `runId` and emits `start_job`. A ready approval node becomes `waiting_approval` with `deadline = now + timeoutMs`.
- **Completion**: once every node is terminal, the run is `failed` if any node `failed` and none of its outgoing edges accept `failed`/`any` (an unhandled failure). Otherwise it is `succeeded`.
- `after_job` chaining is the single-edge special case `{ from: A, to: B, on }`. It stays a trigger for backwards compatibility.

## Engine (`packages/engine`)

- **`WorkflowService`**: CRUD (validation, ownership of inline jobs), `start(id)`, `approve`, `reject`, `cancel`, and the run list/get calls.
- **Node runs** are inserted as `reason: 'workflow'` runs with `workflow: { runId, node }` and the idempotency key `wf:<workflowRunId>:<nodeKey>` (a durable key). Because the `runId` is chosen in the CAS-written state _before_ the insert, a crash between the two is repaired by re-inserting the same id and key.
- **`WorkflowAdvancer implements RunLifecycleListener`**: on `onRunFinished` for a run with `workflow` set, it loads the instance, applies `completeNode`, CAS-writes it (`WorkflowRunRepository.update(next, expectedVersion)`), and applies the effects. On a version conflict it reloads and retries; the transitions are idempotent. A node whose run was cancelled counts as `cancelled`.
- **`WorkflowMonitor extends PollingLoop`** (scheduler role) does three things:
  1. Fires due scheduled workflows. `WorkflowRepository.advanceSchedule` is a CAS on `nextFireAt`, and the instance key `wfsched:<workflowId>:<iso>` has a unique index, so the fire is exactly once.
  2. Fails expired approvals.
  3. Repairs `queued` nodes whose run is missing.
- Cancelling a workflow run cancels its pending and running node runs through `JobService.cancelRun`.

## Persistence

New ports, with contract tests written first in `describePersistenceContract`:

- `WorkflowRepository`: `insert`, `get`, `list`, `update(id, change, expectedVersion)`, `delete`, `findDue({ now, limit })`, `advanceSchedule(id, { from, to })`.
- `WorkflowRunRepository`: `insert` (`duplicate_run` on a key collision), `get`, `list({ workflowId?, status?, … })`, `update(next, expectedVersion)` (`stale_run` on conflict), `findExpiredApprovals({ now, limit })`, `findWithQueuedNodes({ limit })`.

Every adapter stores them as `workflows` and `workflow_runs`. `workflow_runs` has a unique partial index on the idempotency key, plus indexes on workflow id and id, status and id, and the approval deadlines. Mongo uses collections; the SQL adapters use the tables in `persistence-sql/src/tables.ts`, where `workflow_runs` also keeps a `has_queued` hot column for `findWithQueuedNodes`.

## API

| Route                                                     | Scope        |
| --------------------------------------------------------- | ------------ |
| `GET/POST /api/workflows`                                 | read / write |
| `GET/PUT/DELETE /api/workflows/{id}`                      | read / write |
| `POST /api/workflows/{id}/run`                            | write        |
| `GET /api/workflow-runs?workflowId&status`                | read         |
| `GET /api/workflow-runs/{id}`                             | read         |
| `POST /api/workflow-runs/{id}/approve` `{ node }`         | write        |
| `POST /api/workflow-runs/{id}/reject` `{ node, reason? }` | write        |
| `POST /api/workflow-runs/{id}/cancel`                     | write        |

Errors: `NOT_FOUND`, `INVALID_CONFIG` (cycle, unknown node, missing job), and `CONFLICT` (the node is not waiting for approval, the run is already finished, or the job is owned by a workflow). The approver's subject is recorded in `decidedBy`.

## UI

- A Workflows resource with a list, create/edit, show and run pages.
- The editor has a node table (key, kind, job picker / inline job / approval timeout) and an edge table (from, to, on), with a live graph preview.
- Graphs use **React Flow** (`@xyflow/react` 12, which supports React 18). dagre lays the nodes out left to right (`apps/web/src/lib/graph-layout.ts`), and edges follow its bend points. Node colours follow `RUN_STATUS_STYLE`. Approval nodes show Approve and Reject buttons while waiting.
- The run page polls every 2 s while the workflow run is `running`. Node runs keep their own live updates over SSE.
