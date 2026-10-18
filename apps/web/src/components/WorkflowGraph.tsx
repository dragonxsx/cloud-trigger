import { RUN_STATUS_STYLE } from '@cloud-trigger/core';
import { Badge, Group, Stack, Text } from '@mantine/core';
import {
  Background,
  type Edge,
  MarkerType,
  type Node,
  Position,
  ReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';

import '@xyflow/react/dist/style.css';
import { useMemo } from 'react';

import type { NodeStatusDto } from '../lib/api';

interface GraphNode {
  readonly key: string;
  readonly label?: string | undefined;
  readonly kind: 'job' | 'inline' | 'approval';
}

interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly on: 'succeeded' | 'failed' | 'any';
}

interface Props {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly statuses?: Readonly<Record<string, NodeStatusDto>>;
  readonly height?: number;
  readonly onNodeClick?: (key: string) => void;
}

const NODE_STATUS: Record<NodeStatusDto, { label: string; color: string }> = {
  pending: { label: 'Pending', color: RUN_STATUS_STYLE.skipped.color },
  queued: { label: 'Running', color: RUN_STATUS_STYLE.running.color },
  waiting_approval: { label: 'Awaiting approval', color: RUN_STATUS_STYLE.timed_out.color },
  succeeded: RUN_STATUS_STYLE.succeeded,
  failed: RUN_STATUS_STYLE.failed,
  skipped: RUN_STATUS_STYLE.skipped,
  cancelled: RUN_STATUS_STYLE.cancelled,
};

const KIND_LABEL: Record<GraphNode['kind'], string> = {
  job: 'Job',
  inline: 'Inline job',
  approval: 'Approval',
};

const EDGE_COLOR: Record<GraphEdge['on'], string> = {
  succeeded: RUN_STATUS_STYLE.succeeded.color,
  failed: RUN_STATUS_STYLE.failed.color,
  any: RUN_STATUS_STYLE.cancelled.color,
};

export function layeredLayout(
  keys: readonly string[],
  edges: readonly GraphEdge[],
): Map<string, { x: number; y: number }> {
  const depth = new Map(keys.map((key) => [key, 0]));
  for (let pass = 0; pass < keys.length; pass++) {
    for (const edge of edges) {
      const next = (depth.get(edge.from) ?? 0) + 1;
      if (next > (depth.get(edge.to) ?? 0)) {
        depth.set(edge.to, next);
      }
    }
  }
  const rows = new Map<number, number>();

  return new Map(
    keys.map((key) => {
      const column = depth.get(key) ?? 0;
      const row = rows.get(column) ?? 0;
      rows.set(column, row + 1);

      return [key, { x: column * 250, y: row * 110 }];
    }),
  );
}

function NodeLabel({ node, status }: { node: GraphNode; status?: NodeStatusDto | undefined }) {
  return (
    <Stack spacing={2} align="flex-start">
      <Group spacing={6} noWrap>
        <Text size="sm" weight={600} className="ct-mono">
          {node.key}
        </Text>
        <Text size="xs" color="dimmed">
          {KIND_LABEL[node.kind]}
        </Text>
      </Group>
      {node.label && (
        <Text size="xs" lineClamp={1}>
          {node.label}
        </Text>
      )}
      {status && (
        <Badge
          size="xs"
          variant="dot"
          color="gray"
          styles={{ root: { color: NODE_STATUS[status].color } }}
        >
          {NODE_STATUS[status].label}
        </Badge>
      )}
    </Stack>
  );
}

export function WorkflowGraph({ nodes, edges, statuses, height = 320, onNodeClick }: Props) {
  const flow = useMemo(() => {
    const positions = layeredLayout(
      nodes.map((node) => node.key),
      edges,
    );
    const flowNodes: Node[] = nodes.map((node) => {
      const status = statuses?.[node.key];

      return {
        id: node.key,
        position: positions.get(node.key) ?? { x: 0, y: 0 },
        data: { label: <NodeLabel node={node} status={status} /> },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        style: {
          width: 190,
          textAlign: 'left',
          background: 'var(--ct-surface)',
          color: 'var(--ct-ink)',
          border: `2px solid ${status ? NODE_STATUS[status].color : 'var(--ct-line)'}`,
          borderRadius: 8,
          borderStyle: node.kind === 'approval' ? 'dashed' : 'solid',
        },
      };
    });
    const flowEdges: Edge[] = edges.map((edge) => ({
      id: `${edge.from}->${edge.to}`,
      source: edge.from,
      target: edge.to,
      label: edge.on === 'succeeded' ? undefined : `on ${edge.on}`,
      markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_COLOR[edge.on] },
      style: { stroke: EDGE_COLOR[edge.on], strokeWidth: 1.5 },
    }));

    const shape = [
      nodes.map((node) => node.key).join(','),
      edges.map((edge) => `${edge.from}>${edge.to}`).join(','),
    ].join('|');

    return { flowNodes, flowEdges, shape };
  }, [nodes, edges, statuses]);

  return (
    <div style={{ height }} className="ct-panel">
      <ReactFlowProvider key={flow.shape}>
        <ReactFlow
          nodes={flow.flowNodes}
          edges={flow.flowEdges}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          nodesDraggable={false}
          nodesConnectable={false}
          onNodeClick={(_event, node) => onNodeClick?.(node.id)}
        >
          <Background gap={16} size={1} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
