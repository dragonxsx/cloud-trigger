import { describe, expect, it } from 'vitest';

import { JobId, WorkflowId, WorkflowRunId } from '../domain/ids.js';
import type { NodeState, WorkflowRun } from '../domain/workflow-run.js';
import { overlapSlotKey, userEditableJobFields, workflowRunIndex } from './records.js';

const at = (iso: string) => new Date(`2026-01-01T${iso}Z`);

const node = (status: NodeState['status'], deadline: Date | null = null): NodeState => ({
  status,
  runId: null,
  deadline,
  decidedBy: null,
  reason: null,
  finishedAt: null,
});

const run = (status: WorkflowRun['status'], nodes: Record<string, NodeState>): WorkflowRun => ({
  id: WorkflowRunId.parse('0190a0f0-0000-7000-8000-000000000001'),
  workflowId: WorkflowId.parse('0190a0f0-0000-7000-8000-000000000002'),
  workflowName: 'flow',
  workflowVersion: 1,
  status,
  reason: 'manual',
  idempotencyKey: null,
  graph: { nodes: [], edges: [] },
  jobIds: {},
  nodes,
  startedAt: at('00:00:00'),
  finishedAt: null,
  version: 1,
  createdAt: at('00:00:00'),
  updatedAt: at('00:00:00'),
});

describe('workflowRunIndex', () => {
  it('flags queued nodes and the earliest approval deadline of a running run', () => {
    expect(
      workflowRunIndex(
        run('running', {
          a: node('queued'),
          b: node('waiting_approval', at('02:00:00')),
          c: node('waiting_approval', at('01:00:00')),
          d: node('waiting_approval'),
        }),
      ),
    ).toEqual({ hasQueued: true, approvalDeadline: at('01:00:00') });
  });

  it('indexes nothing once the run has finished', () => {
    expect(
      workflowRunIndex(
        run('cancelled', { a: node('queued'), b: node('waiting_approval', at('01:00:00')) }),
      ),
    ).toEqual({ hasQueued: false, approvalDeadline: null });
  });
});

describe('userEditableJobFields', () => {
  it('drops fields outside JobSpec so edits cannot touch scheduler state', () => {
    const fields = userEditableJobFields({ name: 'n', schedule: { fireCount: 9 }, version: 7 });

    expect(fields).toEqual({ name: 'n' });
  });
});

describe('overlapSlotKey', () => {
  it('names the per-job execution and buffer slots', () => {
    const jobId = JobId.parse('0190a0f0-0000-7000-8000-000000000003');

    expect(overlapSlotKey(jobId, 'exec')).toBe(`${jobId}:exec`);
    expect(overlapSlotKey(jobId, 'buffer')).toBe(`${jobId}:buffer`);
  });
});
