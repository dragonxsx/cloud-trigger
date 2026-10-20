import { err, ok, type Result } from 'neverthrow';
import { z } from 'zod';

import type { ConfigError, ConfigIssue } from '../shared/errors.js';
import { EnvironmentChoice } from './environment.js';
import { JobId, WorkflowId } from './ids.js';
import { JobSpec, TriggerRef } from './job.js';

export const NodeKey = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'Lowercase letters, digits, "-" and "_"');

export const InlineJobSpec = JobSpec.omit({ trigger: true, enabled: true, name: true }).describe(
  'A job owned by the workflow; it only runs as part of the workflow.',
);
export type InlineJobSpec = z.output<typeof InlineJobSpec>;

const NodeBase = { key: NodeKey, label: z.string().max(100).optional() };

export const WorkflowNode = z.discriminatedUnion('kind', [
  z
    .object({ ...NodeBase, kind: z.literal('job'), jobId: JobId.meta({ widget: 'job' }) })
    .meta({ title: 'Existing job' }),
  z
    .object({ ...NodeBase, kind: z.literal('inline'), job: InlineJobSpec })
    .meta({ title: 'Inline job' }),
  z
    .object({
      ...NodeBase,
      kind: z.literal('approval'),
      timeoutMs: z
        .int()
        .min(1_000)
        .optional()
        .describe('Fail the gate when nobody decides within this time.'),
    })
    .meta({ title: 'Approval gate' }),
]);
export type WorkflowNode = z.output<typeof WorkflowNode>;

export const EdgeCondition = z.enum(['succeeded', 'failed', 'any']);
export type EdgeCondition = z.output<typeof EdgeCondition>;

export const WorkflowEdge = z.object({
  from: NodeKey,
  to: NodeKey,
  on: EdgeCondition.default('succeeded'),
});
export type WorkflowEdge = z.output<typeof WorkflowEdge>;

export const WorkflowGraph = z.object({
  nodes: z.array(WorkflowNode).min(1).max(100),
  edges: z.array(WorkflowEdge).max(500).default([]),
});
export type WorkflowGraph = z.output<typeof WorkflowGraph>;

export const WorkflowSpec = WorkflowGraph.extend({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2_000).default(''),
  enabled: z.boolean().default(true),
  environment: EnvironmentChoice.describe(
    'Environment for inline jobs that set none; jobs referenced by node keep their own.',
  ),
  schedule: TriggerRef.nullable()
    .default(null)
    .describe('Optional time trigger (cron, interval, rrule, once) that starts the workflow.'),
});
export type WorkflowSpec = z.output<typeof WorkflowSpec>;
export type WorkflowSpecInput = z.input<typeof WorkflowSpec>;

export const Workflow = WorkflowSpec.extend({
  id: WorkflowId,
  inlineJobIds: z
    .record(z.string(), JobId)
    .default({})
    .describe('The jobs created for inline nodes, by node key.'),
  nextFireAt: z.date().nullable(),
  version: z.int().min(1),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Workflow = z.output<typeof Workflow>;

export function topologicalOrder(graph: Pick<WorkflowGraph, 'nodes' | 'edges'>): string[] | null {
  const incoming = new Map(graph.nodes.map((node) => [node.key, 0]));
  for (const edge of graph.edges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }
  const queue = [...incoming.entries()].filter(([, count]) => count === 0).map(([key]) => key);
  const order: string[] = [];
  while (queue.length > 0) {
    const key = queue.shift();
    if (key === undefined) {
      break;
    }
    order.push(key);
    for (const edge of graph.edges.filter((e) => e.from === key)) {
      const remaining = (incoming.get(edge.to) ?? 0) - 1;
      incoming.set(edge.to, remaining);
      if (remaining === 0) {
        queue.push(edge.to);
      }
    }
  }

  return order.length === incoming.size ? order : null;
}

export function validateWorkflowGraph(graph: WorkflowGraph): Result<WorkflowGraph, ConfigError> {
  const issues: ConfigIssue[] = [];
  const keys = new Set<string>();
  graph.nodes.forEach((node, index) => {
    if (keys.has(node.key)) {
      issues.push({ path: `nodes.${index}.key`, message: `Duplicate node key "${node.key}"` });
    }
    keys.add(node.key);
  });
  const seen = new Set<string>();
  graph.edges.forEach((edge, index) => {
    if (!keys.has(edge.from)) {
      issues.push({ path: `edges.${index}.from`, message: `Unknown node "${edge.from}"` });
    }
    if (!keys.has(edge.to)) {
      issues.push({ path: `edges.${index}.to`, message: `Unknown node "${edge.to}"` });
    }
    if (edge.from === edge.to) {
      issues.push({ path: `edges.${index}.to`, message: 'A node cannot depend on itself' });
    }
    const id = `${edge.from}->${edge.to}`;
    if (seen.has(id)) {
      issues.push({ path: `edges.${index}`, message: `Duplicate edge ${edge.from} → ${edge.to}` });
    }
    seen.add(id);
  });
  if (issues.length === 0 && topologicalOrder(graph) === null) {
    issues.push({ path: 'edges', message: 'The workflow graph contains a cycle' });
  }

  return issues.length === 0
    ? ok(graph)
    : err({ code: 'invalid_config', message: 'Invalid workflow', issues });
}

export const nodeJobIds = (
  workflow: Pick<Workflow, 'nodes' | 'inlineJobIds'>,
): Record<string, JobId> =>
  Object.fromEntries(
    workflow.nodes.flatMap((node): [string, JobId][] => {
      if (node.kind === 'job') {
        return [[node.key, node.jobId]];
      }
      const inline = node.kind === 'inline' ? workflow.inlineJobIds[node.key] : undefined;

      return inline === undefined ? [] : [[node.key, inline]];
    }),
  );

export const parentsOf = (graph: Pick<WorkflowGraph, 'edges'>, key: string): WorkflowEdge[] =>
  graph.edges.filter((edge) => edge.to === key);
