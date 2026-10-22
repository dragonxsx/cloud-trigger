import { describe, expect, it } from 'vitest';

import {
  type GraphEdge,
  type GraphNode,
  NODE_WIDTH,
  edgeId,
  layoutGraph,
  nodeHeight,
  routedPath,
} from './graph-layout';

const job = (key: string): GraphNode => ({ key, kind: 'job' });
const edge = (from: string, to: string): GraphEdge => ({ from, to, on: 'succeeded' });

function crossings(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): number {
  const { positions } = layoutGraph(nodes, edges);
  const centre = (key: string) => {
    const position = positions.get(key) ?? { x: 0, y: 0 };
    const node = nodes.find((n) => n.key === key) ?? job(key);

    return { x: position.x, y: position.y + nodeHeight(node, undefined) / 2 };
  };
  let count = 0;
  edges.forEach((one, i) => {
    for (const other of edges.slice(i + 1)) {
      const [s1, t1, s2, t2] = [one.from, one.to, other.from, other.to].map(centre);
      if (!s1 || !t1 || !s2 || !t2 || s1.x !== s2.x || t1.x !== t2.x) {
        continue;
      }
      if ((s1.y - s2.y) * (t1.y - t2.y) < 0) {
        count++;
      }
    }
  });

  return count;
}

describe('layoutGraph', () => {
  it('orders a fan-out so its branches do not cross', () => {
    const nodes = ['a', 'b', 'c', 'e', 'd'].map(job);
    const edges = [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'e')];

    expect(crossings(nodes, edges)).toBe(0);
  });

  it('routes an edge that skips a rank around the node in between', () => {
    const nodes = ['a', 'b', 'c'].map(job);
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('a', 'c')];
    const { positions, routes } = layoutGraph(nodes, edges);
    const box = positions.get('b') ?? { x: 0, y: 0 };
    const height = nodeHeight(job('b'), undefined);
    const bends = routes.get(edgeId(edges[2] ?? edge('a', 'c'), 2))?.bends ?? [];

    expect(bends.length).toBeGreaterThan(0);
    for (const bend of bends.filter((p) => p.x >= box.x && p.x <= box.x + NODE_WIDTH)) {
      expect(bend.y < box.y || bend.y > box.y + height).toBe(true);
    }
  });

  it('drops edges to unknown nodes and keeps duplicate edges apart', () => {
    const nodes = ['a', 'b'].map(job);
    const edges = [edge('a', 'b'), edge('a', 'b'), edge('a', ''), edge('ghost', 'b')];
    const { routes, positions } = layoutGraph(nodes, edges);

    expect([...routes.keys()]).toEqual([edgeId(edge('a', 'b'), 0), edgeId(edge('a', 'b'), 1)]);
    expect([...positions.keys()]).toEqual(['a', 'b']);
  });

  it('lays out keys that collide with Object.prototype members', () => {
    const keys = ['constructor', 'b', 'tostring', '__proto__', 'toString'];
    const edges = [
      edge('constructor', 'b'),
      edge('b', 'toString'),
      edge('__proto__', 'constructor'),
    ];
    const { positions, routes } = layoutGraph(keys.map(job), edges);

    expect([...positions.keys()]).toEqual(keys);
    expect([...routes.keys()]).toEqual(edges.map(edgeId));
  });

  it('returns top-left positions and is deterministic', () => {
    const nodes = [job('only')];

    expect(layoutGraph(nodes, []).positions.get('only')).toEqual({ x: 0, y: 0 });

    const many = ['a', 'b', 'c', 'd'].map(job);
    const edges = [edge('a', 'c'), edge('b', 'c'), edge('c', 'd'), edge('a', 'd')];

    expect(layoutGraph(many, edges)).toEqual(layoutGraph(many, edges));
  });

  it('makes room for a node label and a status', () => {
    const plain = nodeHeight(job('a'), undefined);

    expect(nodeHeight({ ...job('a'), label: 'Load' }, 'succeeded')).toBeGreaterThan(plain);
  });
});

describe('routedPath', () => {
  it('runs from the source through every bend to the target', () => {
    const path = routedPath({ x: 0, y: 0 }, [{ x: 50, y: 20 }], { x: 100, y: 40 });

    expect(path.startsWith('M 0 0')).toBe(true);
    expect(path.endsWith('100 40')).toBe(true);
    expect(path.match(/C /g)).toHaveLength(2);
  });
});
