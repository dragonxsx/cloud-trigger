import { RUN_STATUS_STYLE } from '@cloud-trigger/core';
import { Badge, Group, Stack, Text, useMantineColorScheme } from '@mantine/core';
import { IconUserCheck } from '@tabler/icons-react';
import {
  Background,
  BaseEdge,
  Controls,
  type Edge,
  type EdgeProps,
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
import { countOf } from '../lib/format';
import {
  type EdgeRoute,
  type GraphEdge,
  type GraphNode,
  NODE_WIDTH,
  edgeId,
  layoutGraph,
  routedPath,
} from '../lib/graph-layout';

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
  const count = countOf(nodes.length, 'step');

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
        width: NODE_WIDTH,
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

type RoutedEdge = Edge<EdgeRoute & { readonly text: string }, 'routed'>;

function RoutedEdgeView({
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  markerEnd,
  style,
}: EdgeProps<RoutedEdge>) {
  const path = routedPath({ x: sourceX, y: sourceY }, data?.bends ?? [], {
    x: targetX,
    y: targetY,
  });

  return (
    <BaseEdge
      path={path}
      {...(markerEnd !== undefined && { markerEnd })}
      {...(style !== undefined && { style })}
      {...(data !== undefined && { label: data.text, labelX: data.label.x, labelY: data.label.y })}
      labelStyle={{ fill: 'var(--ct-ink)', fontSize: 12 }}
      labelBgStyle={{ fill: 'var(--ct-surface)' }}
      labelBgPadding={[4, 2]}
      labelBgBorderRadius={4}
    />
  );
}

const EDGE_TYPES = { routed: RoutedEdgeView };

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
    const layout = layoutGraph(nodes, edges, statuses);
    const flowNodes: StepNode[] = nodes.map((node) => ({
      id: node.key,
      type: 'step',
      position: layout.positions.get(node.key) ?? { x: 0, y: 0 },
      data: { node, status: statuses?.[node.key] },
      style: { cursor: clickable ? 'pointer' : 'default' },
    }));
    const flowEdges: RoutedEdge[] = edges.flatMap((edge, index) => {
      const id = edgeId(edge, index);
      const route = layout.routes.get(id);
      if (route === undefined) {
        return [];
      }
      const style = EDGE_STYLE[edge.on];

      return [
        {
          id,
          type: 'routed',
          source: edge.from,
          target: edge.to,
          data: { ...route, text: style.label },
          markerEnd: { type: MarkerType.ArrowClosed, color: style.color },
          style: {
            stroke: style.color,
            strokeWidth: 2,
            ...(style.dash !== undefined && { strokeDasharray: style.dash }),
          },
        },
      ];
    });
    const height = Math.min(480, Math.max(200, layout.height + 90));
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
            edgeTypes={EDGE_TYPES}
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
