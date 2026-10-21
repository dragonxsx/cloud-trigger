import { RUN_STATUS_STYLE } from '@cloud-trigger/core';
import { Badge, Group, Stack, Text, useMantineColorScheme } from '@mantine/core';
import { IconUserCheck } from '@tabler/icons-react';
import {
  Background,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
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
  readonly onNodeClick?: (key: string) => void;
}

export const NODE_STATUS: Record<NodeStatusDto, { label: string; color: string }> = {
  pending: { label: 'Pending', color: RUN_STATUS_STYLE.skipped.color },
  queued: { label: 'Running', color: RUN_STATUS_STYLE.running.color },
  waiting_approval: { label: 'Awaiting approval', color: RUN_STATUS_STYLE.timed_out.color },
  succeeded: RUN_STATUS_STYLE.succeeded,
  failed: RUN_STATUS_STYLE.failed,
  skipped: RUN_STATUS_STYLE.skipped,
  cancelled: RUN_STATUS_STYLE.cancelled,
};

export const KIND_LABEL: Record<GraphNode['kind'], string> = {
  job: 'Existing job',
  inline: 'Inline job',
  approval: 'Approval',
};

const EDGE_STYLE: Record<
  GraphEdge['on'],
  { color: string; dash: string | undefined; label: string; verb: string }
> = {
  succeeded: {
    color: RUN_STATUS_STYLE.succeeded.color,
    dash: undefined,
    label: 'on success',
    verb: 'succeeds',
  },
  failed: {
    color: RUN_STATUS_STYLE.failed.color,
    dash: '7 4',
    label: 'on failure',
    verb: 'fails',
  },
  any: {
    color: RUN_STATUS_STYLE.cancelled.color,
    dash: '2 4',
    label: 'always',
    verb: 'finishes',
  },
};

const APPROVAL_COLOR = RUN_STATUS_STYLE.timed_out.color;
const COLUMN_WIDTH = 340;
const ROW_HEIGHT = 110;

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

      return [key, { x: column * COLUMN_WIDTH, y: row * ROW_HEIGHT }];
    }),
  );
}

export function NodeStatusBadge({ status }: { status: NodeStatusDto }) {
  const style = NODE_STATUS[status];

  return (
    <Badge
      variant="dot"
      color={style.color}
      radius="sm"
      styles={{ root: { textTransform: 'none', fontWeight: 600 } }}
    >
      {style.label}
    </Badge>
  );
}

export function graphSummary(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  statuses?: Readonly<Record<string, NodeStatusDto>>,
): string {
  const steps = nodes.map((node) => {
    const status = statuses?.[node.key];
    const kind = node.kind === 'approval' ? ' (approval gate)' : '';

    return status ? `${node.key}${kind}: ${NODE_STATUS[status].label}` : `${node.key}${kind}`;
  });
  const order = edges.map(
    (edge) => `${edge.to} runs after ${edge.from} ${EDGE_STYLE[edge.on].verb}`,
  );
  const count = nodes.length === 1 ? '1 step' : `${String(nodes.length)} steps`;

  return [`Workflow graph with ${count}: ${steps.join(', ')}.`, ...order.map((s) => `${s}.`)].join(
    ' ',
  );
}

type StepData = {
  readonly node: GraphNode;
  readonly status: NodeStatusDto | undefined;
};
type StepNode = Node<StepData, 'step'>;

const HIDDEN_HANDLE = { visibility: 'hidden', pointerEvents: 'none' } as const;

function StepNodeView({ data }: NodeProps<StepNode>) {
  const { node, status } = data;
  const approval = node.kind === 'approval';
  const border = status ? NODE_STATUS[status].color : approval ? APPROVAL_COLOR : 'var(--ct-line)';

  return (
    <div
      style={{
        width: 190,
        padding: '8px 10px',
        textAlign: 'left',
        color: 'var(--ct-ink)',
        background: approval
          ? `color-mix(in srgb, ${APPROVAL_COLOR} 12%, var(--ct-surface))`
          : 'var(--ct-surface)',
        border: `2px ${approval ? 'dashed' : 'solid'} ${border}`,
        borderRadius: 8,
      }}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} style={HIDDEN_HANDLE} />
      <Stack spacing={4} align="flex-start">
        <Group spacing={6} noWrap>
          {approval && <IconUserCheck size={14} color={APPROVAL_COLOR} aria-hidden />}
          <Text size="sm" weight={600} className="ct-mono" lineClamp={1}>
            {node.key}
          </Text>
        </Group>
        {approval ? (
          <Badge
            size="xs"
            color="orange"
            variant="light"
            radius="sm"
            sx={(theme) =>
              theme.colorScheme === 'light'
                ? { color: theme.fn.darken(theme.colors.orange[9], 0.3) }
                : {}
            }
          >
            Approval gate
          </Badge>
        ) : (
          <Text size="xs" style={{ color: 'var(--ct-muted)' }}>
            {KIND_LABEL[node.kind]}
          </Text>
        )}
        {node.label && (
          <Text size="xs" lineClamp={1}>
            {node.label}
          </Text>
        )}
        {status && <NodeStatusBadge status={status} />}
      </Stack>
      <Handle type="source" position={Position.Right} isConnectable={false} style={HIDDEN_HANDLE} />
    </div>
  );
}

const NODE_TYPES = { step: StepNodeView };

function EdgeLegend({ edges }: { edges: readonly GraphEdge[] }) {
  const present = (['succeeded', 'failed', 'any'] as const).filter((on) =>
    edges.some((edge) => edge.on === on),
  );
  if (present.length === 0) {
    return null;
  }

  return (
    <Group spacing="md" px="sm" pb="xs" aria-hidden>
      {present.map((on) => (
        <Group key={on} spacing={6} noWrap>
          <svg width={28} height={8} aria-hidden>
            <line
              x1={0}
              y1={4}
              x2={28}
              y2={4}
              stroke={EDGE_STYLE[on].color}
              strokeWidth={2}
              strokeDasharray={EDGE_STYLE[on].dash}
            />
          </svg>
          <Text size="xs" style={{ color: 'var(--ct-muted)' }}>
            Runs {EDGE_STYLE[on].label}
          </Text>
        </Group>
      ))}
    </Group>
  );
}

export function WorkflowGraph({ nodes, edges, statuses, onNodeClick }: Props) {
  const { colorScheme } = useMantineColorScheme();
  const clickable = onNodeClick !== undefined;
  const flow = useMemo(() => {
    const positions = layeredLayout(
      nodes.map((node) => node.key),
      edges,
    );
    const flowNodes: StepNode[] = nodes.map((node) => ({
      id: node.key,
      type: 'step',
      position: positions.get(node.key) ?? { x: 0, y: 0 },
      data: { node, status: statuses?.[node.key] },
      style: { cursor: clickable ? 'pointer' : 'default' },
    }));
    const flowEdges: Edge[] = edges.map((edge, index) => {
      const style = EDGE_STYLE[edge.on];

      return {
        id: `${edge.from}->${edge.to}:${edge.on}:${String(index)}`,
        source: edge.from,
        target: edge.to,
        label: style.label,
        labelStyle: { fill: 'var(--ct-ink)', fontSize: 12 },
        labelBgStyle: { fill: 'var(--ct-surface)' },
        labelBgPadding: [4, 2],
        labelBgBorderRadius: 4,
        markerEnd: { type: MarkerType.ArrowClosed, color: style.color },
        style: {
          stroke: style.color,
          strokeWidth: 2,
          ...(style.dash !== undefined && { strokeDasharray: style.dash }),
        },
      };
    });
    const rowsPerColumn = new Map<number, number>();
    for (const position of positions.values()) {
      rowsPerColumn.set(position.x, (rowsPerColumn.get(position.x) ?? 0) + 1);
    }
    const tallest = Math.max(1, ...rowsPerColumn.values());
    const height = Math.min(480, Math.max(200, tallest * ROW_HEIGHT + 90));
    const shape = [
      nodes.map((node) => node.key).join(','),
      edges.map((edge) => `${edge.from}>${edge.to}`).join(','),
    ].join('|');

    return { flowNodes, flowEdges, height, shape };
  }, [nodes, edges, statuses, clickable]);

  return (
    <figure className="ct-panel" style={{ margin: 0 }}>
      <figcaption className="ct-sr-only">{graphSummary(nodes, edges, statuses)}</figcaption>
      <div style={{ height: flow.height }}>
        <ReactFlowProvider key={flow.shape}>
          <ReactFlow
            nodes={flow.flowNodes}
            edges={flow.flowEdges}
            nodeTypes={NODE_TYPES}
            colorMode={colorScheme}
            fitView
            fitViewOptions={{ padding: 0.2, minZoom: 0.8, maxZoom: 1.1 }}
            minZoom={0.3}
            nodesDraggable={false}
            nodesConnectable={false}
            nodesFocusable={false}
            edgesFocusable={false}
            elementsSelectable={false}
            disableKeyboardA11y
            zoomOnScroll={false}
            zoomOnDoubleClick={false}
            preventScrolling={false}
            {...(onNodeClick !== undefined && {
              onNodeClick: (_event, node) => onNodeClick(node.id),
            })}
          >
            <Background gap={16} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
      <EdgeLegend edges={edges} />
    </figure>
  );
}
