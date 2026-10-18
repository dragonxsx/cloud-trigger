import { z } from 'zod';

import { assertNever } from '../shared/assert-never.js';
import { JobId, RunId, WorkflowId, WorkflowRunId, newRunId } from './ids.js';
import { type Workflow, WorkflowGraph, type WorkflowNode, parentsOf } from './workflow.js';

export const NodeStatus = z.enum([
  'pending',
  'queued',
  'waiting_approval',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
]);
export type NodeStatus = z.output<typeof NodeStatus>;

export const NodeState = z.object({
  status: NodeStatus,
  runId: RunId.nullable(),
  deadline: z.date().nullable(),
  decidedBy: z.string().nullable(),
  reason: z.string().nullable(),
  finishedAt: z.date().nullable(),
});
export type NodeState = z.output<typeof NodeState>;

export const WorkflowRunStatus = z.enum(['running', 'succeeded', 'failed', 'cancelled']);
export type WorkflowRunStatus = z.output<typeof WorkflowRunStatus>;

export const WorkflowRun = z.object({
  id: WorkflowRunId,
  workflowId: WorkflowId,
  workflowName: z.string(),
  workflowVersion: z.int().min(1),
  status: WorkflowRunStatus,
  reason: z.enum(['manual', 'scheduled']),
  idempotencyKey: z.string().nullable(),
  graph: WorkflowGraph.describe('The graph as it was when the run started.'),
  jobIds: z.record(z.string(), JobId).describe('The job each job node runs, by node key.'),
  nodes: z.record(z.string(), NodeState),
  startedAt: z.date(),
  finishedAt: z.date().nullable(),
  version: z.int().min(1),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type WorkflowRun = z.output<typeof WorkflowRun>;

export type WorkflowEffect =
  | {
      readonly type: 'start_job';
      readonly key: string;
      readonly runId: RunId;
      readonly jobId: JobId;
    }
  | { readonly type: 'cancel_run'; readonly runId: RunId };

export interface Transition {
  readonly run: WorkflowRun;
  readonly effects: readonly WorkflowEffect[];
}

export type NodeOutcome = 'succeeded' | 'failed' | 'cancelled';

const TERMINAL: ReadonlySet<NodeStatus> = new Set(['succeeded', 'failed', 'skipped', 'cancelled']);
export const isNodeTerminal = (state: NodeState | undefined): boolean =>
  state !== undefined && TERMINAL.has(state.status);

const blankNode = (): NodeState => ({
  status: 'pending',
  runId: null,
  deadline: null,
  decidedBy: null,
  reason: null,
  finishedAt: null,
});

const edgeSatisfied = (on: 'succeeded' | 'failed' | 'any', source: NodeStatus): boolean =>
  (source === 'succeeded' && (on === 'succeeded' || on === 'any')) ||
  (source === 'failed' && (on === 'failed' || on === 'any'));

function activate(
  node: WorkflowNode,
  jobIds: Readonly<Record<string, JobId>>,
  now: Date,
): { state: NodeState; effect?: WorkflowEffect } {
  switch (node.kind) {
    case 'job':
    case 'inline': {
      const jobId = jobIds[node.key];
      if (jobId === undefined) {
        return {
          state: { ...blankNode(), status: 'failed', reason: 'Job is missing', finishedAt: now },
        };
      }
      const runId = newRunId();

      return {
        state: { ...blankNode(), status: 'queued', runId },
        effect: { type: 'start_job', key: node.key, runId, jobId },
      };
    }
    case 'approval':
      return {
        state: {
          ...blankNode(),
          status: 'waiting_approval',
          deadline: node.timeoutMs === undefined ? null : new Date(now.getTime() + node.timeoutMs),
        },
      };
    default:
      return assertNever(node);
  }
}

function settle(run: WorkflowRun, now: Date): Transition {
  const nodes = { ...run.nodes };
  const effects: WorkflowEffect[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of run.graph.nodes) {
      if (nodes[node.key]?.status !== 'pending') {
        continue;
      }
      const parents = parentsOf(run.graph, node.key);
      if (!parents.every((edge) => isNodeTerminal(nodes[edge.from]))) {
        continue;
      }
      const ready = parents.every((edge) =>
        edgeSatisfied(edge.on, nodes[edge.from]?.status ?? 'pending'),
      );
      if (ready) {
        const activated = activate(node, run.jobIds, now);
        nodes[node.key] = activated.state;
        if (activated.effect) {
          effects.push(activated.effect);
        }
      } else {
        nodes[node.key] = {
          ...blankNode(),
          status: 'skipped',
          reason: 'Upstream condition not met',
          finishedAt: now,
        };
      }
      changed = true;
    }
  }

  const allTerminal = run.graph.nodes.every((node) => isNodeTerminal(nodes[node.key]));
  const cancelled = run.graph.nodes.some((node) => nodes[node.key]?.status === 'cancelled');
  const unhandledFailure = run.graph.nodes.some(
    (node) =>
      nodes[node.key]?.status === 'failed' &&
      !run.graph.edges.some(
        (edge) => edge.from === node.key && (edge.on === 'failed' || edge.on === 'any'),
      ),
  );
  const status: WorkflowRunStatus =
    run.status !== 'running'
      ? run.status
      : !allTerminal
        ? 'running'
        : cancelled
          ? 'cancelled'
          : unhandledFailure
            ? 'failed'
            : 'succeeded';

  return {
    run: {
      ...run,
      nodes,
      status,
      finishedAt: status === 'running' ? null : (run.finishedAt ?? now),
      updatedAt: now,
    },
    effects,
  };
}

export function startWorkflowRun(
  workflow: Workflow,
  p: {
    id: WorkflowRunId;
    jobIds: Readonly<Record<string, JobId>>;
    reason: 'manual' | 'scheduled';
    idempotencyKey?: string | null;
    now: Date;
  },
): Transition {
  return settle(
    {
      id: p.id,
      workflowId: workflow.id,
      workflowName: workflow.name,
      workflowVersion: workflow.version,
      status: 'running',
      reason: p.reason,
      idempotencyKey: p.idempotencyKey ?? null,
      graph: { nodes: workflow.nodes, edges: workflow.edges },
      jobIds: { ...p.jobIds },
      nodes: Object.fromEntries(workflow.nodes.map((node) => [node.key, blankNode()])),
      startedAt: p.now,
      finishedAt: null,
      version: 1,
      createdAt: p.now,
      updatedAt: p.now,
    },
    p.now,
  );
}

export function completeNode(
  run: WorkflowRun,
  key: string,
  outcome: NodeOutcome,
  p: { runId: RunId; now: Date },
): Transition | undefined {
  const state = run.nodes[key];
  if (state?.status !== 'queued' || state.runId !== p.runId) {
    return undefined;
  }

  return settle(
    {
      ...run,
      nodes: { ...run.nodes, [key]: { ...state, status: outcome, finishedAt: p.now } },
    },
    p.now,
  );
}

export function decideApproval(
  run: WorkflowRun,
  key: string,
  p: { approved: boolean; by: string; reason?: string | undefined; now: Date },
): Transition | undefined {
  const state = run.nodes[key];
  if (run.status !== 'running' || state?.status !== 'waiting_approval') {
    return undefined;
  }

  return settle(
    {
      ...run,
      nodes: {
        ...run.nodes,
        [key]: {
          ...state,
          status: p.approved ? 'succeeded' : 'failed',
          decidedBy: p.by,
          reason: p.reason ?? (p.approved ? 'Approved' : 'Rejected'),
          finishedAt: p.now,
        },
      },
    },
    p.now,
  );
}

export function expireApprovals(run: WorkflowRun, now: Date): Transition | undefined {
  const expired = Object.entries(run.nodes).filter(
    ([, state]) =>
      state.status === 'waiting_approval' &&
      state.deadline !== null &&
      state.deadline.getTime() <= now.getTime(),
  );
  if (run.status !== 'running' || expired.length === 0) {
    return undefined;
  }
  const nodes = { ...run.nodes };
  for (const [key, state] of expired) {
    nodes[key] = { ...state, status: 'failed', reason: 'Approval timed out', finishedAt: now };
  }

  return settle({ ...run, nodes }, now);
}

export function cancelWorkflowRun(run: WorkflowRun, now: Date): Transition | undefined {
  if (run.status !== 'running') {
    return undefined;
  }
  const effects: WorkflowEffect[] = [];
  const nodes = Object.fromEntries(
    Object.entries(run.nodes).map(([key, state]): [string, NodeState] => {
      if (TERMINAL.has(state.status)) {
        return [key, state];
      }
      if (state.status === 'queued' && state.runId !== null) {
        effects.push({ type: 'cancel_run', runId: state.runId });
      }

      return [
        key,
        { ...state, status: 'cancelled', reason: 'Workflow cancelled', finishedAt: now },
      ];
    }),
  );

  return {
    run: { ...run, nodes, status: 'cancelled', finishedAt: now, updatedAt: now },
    effects,
  };
}
