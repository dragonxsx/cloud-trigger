import { describe, expect, it } from 'vitest';

import { newJobId, newWorkflowId, newWorkflowRunId } from './ids.js';
import {
  type Transition,
  type WorkflowRun,
  cancelWorkflowRun,
  completeNode,
  decideApproval,
  expireApprovals,
  startWorkflowRun,
} from './workflow-run.js';
import {
  type Workflow,
  WorkflowSpec,
  type WorkflowSpecInput,
  nodeJobIds,
  validateWorkflowGraph,
} from './workflow.js';

const T0 = new Date('2026-01-01T00:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const [A, B, C, D] = [newJobId(), newJobId(), newJobId(), newJobId()];

const workflow = (spec: Partial<WorkflowSpecInput> = {}): Workflow => ({
  ...WorkflowSpec.parse({
    name: 'release',
    nodes: [
      { key: 'build', kind: 'job', jobId: A },
      { key: 'test', kind: 'job', jobId: B },
      { key: 'gate', kind: 'approval', timeoutMs: 60_000 },
      { key: 'deploy', kind: 'job', jobId: C },
      { key: 'rollback', kind: 'job', jobId: D },
    ],
    edges: [
      { from: 'build', to: 'test' },
      { from: 'test', to: 'gate' },
      { from: 'gate', to: 'deploy' },
      { from: 'deploy', to: 'rollback', on: 'failed' },
    ],
    ...spec,
  }),
  id: newWorkflowId(),
  inlineJobIds: {},
  nextFireAt: null,
  version: 1,
  createdAt: T0,
  updatedAt: T0,
});

const start = (wf: Workflow = workflow()) =>
  startWorkflowRun(wf, {
    id: newWorkflowRunId(),
    jobIds: nodeJobIds(wf),
    reason: 'manual',
    now: T0,
  });

const runIdOf = (run: WorkflowRun, key: string) => {
  const runId = run.nodes[key]?.runId;
  if (!runId) {
    throw new Error(`node ${key} has no run`);
  }

  return runId;
};

const finish = (
  t: Transition | undefined,
  key: string,
  outcome: 'succeeded' | 'failed',
  ms: number,
) => {
  if (!t) {
    throw new Error('expected a transition');
  }
  const next = completeNode(t.run, key, outcome, { runId: runIdOf(t.run, key), now: at(ms) });
  if (!next) {
    throw new Error(`node ${key} could not complete`);
  }

  return next;
};

const statuses = (run: WorkflowRun) =>
  Object.fromEntries(Object.entries(run.nodes).map(([key, state]) => [key, state.status]));

describe('workflow validation', () => {
  it('rejects cycles, unknown nodes, self edges and duplicate keys with paths', () => {
    const issues = (spec: Partial<WorkflowSpecInput>) => {
      const result = validateWorkflowGraph(workflow(spec));

      return result.isErr() ? result.error.issues.map((issue) => issue.path) : [];
    };
    expect(
      issues({
        nodes: [
          { key: 'a', kind: 'approval' },
          { key: 'b', kind: 'approval' },
        ],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' },
        ],
      }),
    ).toEqual(['edges']);
    expect(
      issues({
        nodes: [
          { key: 'a', kind: 'approval' },
          { key: 'a', kind: 'approval' },
        ],
        edges: [
          { from: 'a', to: 'zz' },
          { from: 'a', to: 'a' },
        ],
      }),
    ).toEqual(['nodes.1.key', 'edges.0.to', 'edges.1.to']);
    expect(validateWorkflowGraph(workflow()).isOk()).toBe(true);
  });
});

describe('workflow runs', () => {
  it('starts the roots, then advances along satisfied edges to the gate', () => {
    const started = start();
    expect(statuses(started.run)).toMatchObject({ build: 'queued', test: 'pending' });
    expect(started.effects).toEqual([
      { type: 'start_job', key: 'build', runId: runIdOf(started.run, 'build'), jobId: A },
    ]);

    const tested = finish(finish(started, 'build', 'succeeded', 1), 'test', 'succeeded', 2);
    expect(statuses(tested.run)).toMatchObject({ gate: 'waiting_approval', deploy: 'pending' });
    expect(tested.run.nodes['gate']?.deadline).toEqual(at(2 + 60_000));
    expect(tested.run.status).toBe('running');
  });

  it('runs the deploy after approval and skips the failure branch on success', () => {
    const tested = finish(finish(start(), 'build', 'succeeded', 1), 'test', 'succeeded', 2);
    const approved = decideApproval(tested.run, 'gate', {
      approved: true,
      by: 'alice',
      now: at(3),
    });
    expect(approved?.run.nodes['gate']).toMatchObject({ status: 'succeeded', decidedBy: 'alice' });
    expect(approved?.effects.map((e) => e.type === 'start_job' && e.key)).toEqual(['deploy']);

    const done = finish(approved, 'deploy', 'succeeded', 4);
    expect(statuses(done.run)).toMatchObject({ deploy: 'succeeded', rollback: 'skipped' });
    expect(done.run).toMatchObject({ status: 'succeeded', finishedAt: at(4) });
  });

  it('follows failure edges, and a handled failure does not fail the run', () => {
    const tested = finish(finish(start(), 'build', 'succeeded', 1), 'test', 'succeeded', 2);
    const approved = decideApproval(tested.run, 'gate', { approved: true, by: 'a', now: at(3) });
    const failed = finish(approved, 'deploy', 'failed', 4);
    expect(statuses(failed.run)).toMatchObject({ rollback: 'queued' });
    const rolledBack = finish(failed, 'rollback', 'succeeded', 5);
    expect(rolledBack.run.status).toBe('succeeded');
  });

  it('fails the run on an unhandled failure and skips everything downstream', () => {
    const failed = finish(start(), 'build', 'failed', 1);
    expect(statuses(failed.run)).toEqual({
      build: 'failed',
      test: 'skipped',
      gate: 'skipped',
      deploy: 'skipped',
      rollback: 'skipped',
    });
    expect(failed.run.status).toBe('failed');
  });

  it('fails a gate that times out or is rejected', () => {
    const tested = finish(finish(start(), 'build', 'succeeded', 1), 'test', 'succeeded', 2);
    expect(expireApprovals(tested.run, at(30_000))).toBeUndefined();
    const expired = expireApprovals(tested.run, at(60_002));
    expect(expired?.run.nodes['gate']).toMatchObject({
      status: 'failed',
      reason: 'Approval timed out',
    });
    expect(expired?.run.status).toBe('failed');

    const rejected = decideApproval(tested.run, 'gate', { approved: false, by: 'bob', now: at(3) });
    expect(rejected?.run.status).toBe('failed');
    expect(
      decideApproval(rejected?.run ?? tested.run, 'gate', { approved: true, by: 'x', now: at(4) }),
    ).toBeUndefined();
  });

  it('joins on all parents and ignores stale or repeated completions', () => {
    const wf = workflow({
      nodes: [
        { key: 'a', kind: 'job', jobId: A },
        { key: 'b', kind: 'job', jobId: B },
        { key: 'c', kind: 'job', jobId: C },
      ],
      edges: [
        { from: 'a', to: 'c' },
        { from: 'b', to: 'c' },
      ],
    });
    const started = start(wf);
    expect(started.effects.map((e) => e.type === 'start_job' && e.key)).toEqual(['a', 'b']);
    const oneDone = finish(started, 'a', 'succeeded', 1);
    expect(oneDone.run.nodes['c']?.status).toBe('pending');
    expect(
      completeNode(oneDone.run, 'a', 'succeeded', { runId: runIdOf(oneDone.run, 'a'), now: at(2) }),
    ).toBeUndefined();
    const both = finish(oneDone, 'b', 'succeeded', 3);
    expect(both.run.nodes['c']?.status).toBe('queued');
  });

  it('cancels outstanding nodes and their runs', () => {
    const started = start();
    const cancelled = cancelWorkflowRun(started.run, at(1));
    expect(cancelled?.run.status).toBe('cancelled');
    expect(cancelled?.effects).toEqual([
      { type: 'cancel_run', runId: runIdOf(started.run, 'build') },
    ]);
    expect(cancelWorkflowRun(cancelled?.run ?? started.run, at(2))).toBeUndefined();
  });
});
