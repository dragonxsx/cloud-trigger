import {
  type EdgeLabel,
  type GraphLabel,
  type NodeLabel,
  type Point,
  graphlib,
  layout,
} from '@dagrejs/dagre';

import type { NodeStatusDto } from './api';

export interface GraphNode {
  readonly key: string;
  readonly label?: string | undefined;
  readonly kind: 'job' | 'inline' | 'approval';
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly on: 'succeeded' | 'failed' | 'any';
}

export type EdgeRoute = {
  readonly bends: readonly Point[];
  readonly label: Point;
};

export interface GraphLayout {
  readonly positions: ReadonlyMap<string, Point>;
  readonly routes: ReadonlyMap<string, EdgeRoute>;
  readonly width: number;
  readonly height: number;
}

export const NODE_WIDTH = 190;
const EDGE_LABEL = { width: 76, height: 20 };

export function nodeHeight(node: GraphNode, status: NodeStatusDto | undefined): number {
  return 66 + (node.label ? 23 : 0) + (status ? 24 : 0);
}

export const edgeId = (edge: GraphEdge, index: number): string =>
  `${edge.from}->${edge.to}:${edge.on}:${String(index)}`;

export function layoutGraph(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  statuses?: Readonly<Record<string, NodeStatusDto>>,
): GraphLayout {
  const graph = new graphlib.Graph<GraphLabel, NodeLabel, EdgeLabel>({ multigraph: true });
  graph.setGraph({ rankdir: 'LR', nodesep: 32, edgesep: 16, ranksep: 48, marginx: 0, marginy: 0 });
  const placed = new Map<string, { id: string; height: number }>();
  nodes.forEach((node, index) => {
    if (placed.has(node.key)) {
      return;
    }
    const id = `n${String(index)}`;
    const height = nodeHeight(node, statuses?.[node.key]);
    placed.set(node.key, { id, height });
    graph.setNode(id, { width: NODE_WIDTH, height });
  });
  const laidOut = edges.flatMap((edge, index) => {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);

    return from && to
      ? [{ id: edgeId(edge, index), from: from.id, to: to.id, name: `e${String(index)}` }]
      : [];
  });
  for (const { from, to, name } of laidOut) {
    graph.setEdge(from, to, { ...EDGE_LABEL, labelpos: 'c' }, name);
  }
  layout(graph);

  const positions = new Map<string, Point>();
  for (const [key, { id, height }] of placed) {
    const { x = 0, y = 0 } = graph.node(id);
    positions.set(key, { x: x - NODE_WIDTH / 2, y: y - height / 2 });
  }
  const routes = new Map<string, EdgeRoute>();
  for (const { id, from, to, name } of laidOut) {
    const { points = [], x, y } = graph.edge(from, to, name);
    const bends = points.slice(1, -1);
    const middle = bends[Math.floor(bends.length / 2)] ?? { x: 0, y: 0 };
    routes.set(id, { bends, label: { x: x ?? middle.x, y: y ?? middle.y } });
  }
  const { width = 0, height = 0 } = graph.graph();

  return { positions, routes, width, height };
}

export function routedPath(source: Point, bends: readonly Point[], target: Point): string {
  const points = [source, ...bends, target];
  const segments = points.slice(1).map((to, index) => {
    const from = points[index] ?? source;
    const midX = (from.x + to.x) / 2;

    return `C ${String(midX)} ${String(from.y)}, ${String(midX)} ${String(to.y)}, ${String(to.x)} ${String(to.y)}`;
  });

  return [`M ${String(source.x)} ${String(source.y)}`, ...segments].join(' ');
}
