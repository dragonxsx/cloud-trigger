import type { ConnectionSpec } from '../domain/connection.js';
import type { GroupSpec } from '../domain/group.js';
import { JobSpec } from '../domain/job.js';
import type { NotificationDelivery } from '../domain/notification.js';
import type { RunStatus } from '../domain/run.js';
import type { WorkflowRun } from '../domain/workflow-run.js';
import type { WorkflowChange } from '../ports/workflows.js';

export const SUCCESS_LIKE_STATUSES: readonly RunStatus[] = ['succeeded', 'cancelled', 'skipped'];
export const FAILURE_LIKE_STATUSES: readonly RunStatus[] = ['failed', 'timed_out'];

export const pruneGroups = (keep: {
  readonly succeeded: number;
  readonly failed: number;
}): readonly (readonly [readonly RunStatus[], number])[] => [
  [SUCCESS_LIKE_STATUSES, keep.succeeded],
  [FAILURE_LIKE_STATUSES, keep.failed],
];

export type OverlapSlot = 'exec' | 'buffer';
export const overlapSlotKey = (jobId: string, slot: OverlapSlot): string => `${jobId}:${slot}`;

export const AUTO_PAUSE_REASON = {
  prefix: 'Auto-paused after ',
  suffix: ' consecutive failures',
} as const;

const SPEC_FIELDS: ReadonlySet<string> = new Set(Object.keys(JobSpec.shape));

export const userEditableJobFields = (
  spec: Readonly<Record<string, unknown>>,
): Record<string, unknown> =>
  Object.fromEntries(Object.entries(spec).filter(([key]) => SPEC_FIELDS.has(key)));

export const groupUpdateFields = (
  update: { readonly spec: GroupSpec; readonly updatedAt: Date },
  expectedVersion: number,
) => ({ ...update.spec, updatedAt: update.updatedAt, version: expectedVersion + 1 });

export const connectionUpdateFields = (
  update: { readonly spec: ConnectionSpec; readonly updatedAt: Date },
  expectedVersion: number,
) => ({ ...update.spec, updatedAt: update.updatedAt, version: expectedVersion + 1 });

export const workflowChangeFields = (change: WorkflowChange, expectedVersion: number) => ({
  ...change.spec,
  inlineJobIds: { ...change.inlineJobIds },
  nextFireAt: change.nextFireAt,
  updatedAt: change.updatedAt,
  version: expectedVersion + 1,
});

export const savedWorkflowRun = (next: WorkflowRun, expectedVersion: number): WorkflowRun => ({
  ...next,
  version: expectedVersion + 1,
});

export interface WorkflowRunIndex {
  readonly hasQueued: boolean;
  readonly approvalDeadline: Date | null;
}

export const workflowRunIndex = (run: WorkflowRun): WorkflowRunIndex => {
  const states = Object.values(run.nodes);
  const deadlines = states.flatMap((state) =>
    state.status === 'waiting_approval' && state.deadline !== null
      ? [state.deadline.getTime()]
      : [],
  );

  return {
    hasQueued: run.status === 'running' && states.some((state) => state.status === 'queued'),
    approvalDeadline:
      run.status === 'running' && deadlines.length > 0 ? new Date(Math.min(...deadlines)) : null,
  };
};

export const failedDeliveryFields = (
  claimed: NotificationDelivery,
  p: { readonly error: string; readonly retryAt: Date | null; readonly now: Date },
) => ({
  status: p.retryAt ? ('pending' as const) : ('failed' as const),
  availableAt: p.retryAt ?? claimed.availableAt,
  lastError: p.error,
  updatedAt: p.now,
});

export const AUTH_SETTINGS_ID = 'auth';

export const normalizeUsername = (username: string): string => username.toLowerCase();
