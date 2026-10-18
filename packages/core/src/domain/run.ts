import { z } from 'zod';

import { assertNever } from '../shared/assert-never.js';
import { GroupId, JobId, RunId } from './ids.js';
import type { Job } from './job.js';
import { computeRetryDelay, type RetryPolicy, type SlaPolicy } from './policy.js';
import { EngineErrorCode, TargetResult, failedResult } from './target-result.js';

export const RunReason = z.enum([
  'scheduled',
  'manual',
  'retry',
  'catchup',
  'backfill',
  'chained',
  'replay',
]);
export type RunReason = z.output<typeof RunReason>;

export const Lease = z.object({ workerId: z.string().min(1), until: z.date() });
export type Lease = z.output<typeof Lease>;

export const AttemptRecord = z.object({
  attempt: z.int().min(1),
  workerId: z.string(),
  startedAt: z.date(),
  finishedAt: z.date(),
  result: TargetResult,
});
export type AttemptRecord = z.output<typeof AttemptRecord>;

export const ParentSnapshot = z
  .object({
    runId: RunId,
    jobId: JobId,
    jobName: z.string(),
    status: z.string(),
    result: TargetResult.nullable(),
  })
  .describe('The upstream run as it finished, so pruning its history keeps the chained context.');
export type ParentSnapshot = z.output<typeof ParentSnapshot>;

const RunBase = z.object({
  id: RunId,
  jobId: JobId,
  jobName: z.string(),
  jobVersion: z.int().min(1),
  reason: RunReason,
  scheduledAt: z.date(),
  idempotencyKey: z.string().nullable(),
  attempts: z.array(AttemptRecord),
  late: z.boolean(),
  lateReasons: z.array(z.string()).default([]),
  slaDeadline: z
    .date()
    .nullable()
    .default(null)
    .describe('When the run breaches its SLA if still pending or running; null once checked.'),
  slaMaxDurationMs: z.int().min(1).nullable().default(null),
  acknowledgedAt: z
    .date()
    .nullable()
    .default(null)
    .describe('Set when a failed run is dismissed from the failed-runs inbox.'),
  parentRunId: RunId.nullable().default(null),
  parent: ParentSnapshot.nullable().default(null),
  groupId: GroupId.nullable().default(null),
  rateLimitKey: z
    .string()
    .nullable()
    .default(null)
    .describe('Rate-limit slot held while running; released when the run leaves `running`.'),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const PendingRun = RunBase.extend({
  status: z.literal('pending'),
  availableAt: z.date(),
});
export type PendingRun = z.output<typeof PendingRun>;

export const RunningRun = RunBase.extend({
  status: z.literal('running'),
  startedAt: z.date(),
  lease: Lease,
  cancelRequested: z
    .boolean()
    .describe(
      'Set by an API cancel or the `replace` overlap policy; the owning worker aborts on its next heartbeat.',
    ),
});
export type RunningRun = z.output<typeof RunningRun>;

export const TerminalStatus = z.enum(['succeeded', 'failed', 'timed_out', 'cancelled']);
export type TerminalStatus = z.output<typeof TerminalStatus>;

export const FinishedRun = RunBase.extend({
  status: TerminalStatus,
  finishedAt: z.date(),
  result: TargetResult.nullable().describe(
    'Result of the final attempt; null when cancelled before execution.',
  ),
});
export type FinishedRun = z.output<typeof FinishedRun>;

export const SkippedRun = RunBase.extend({
  status: z.literal('skipped'),
  finishedAt: z.date(),
  skipReason: z.string(),
});
export type SkippedRun = z.output<typeof SkippedRun>;

export const Run = z.discriminatedUnion('status', [
  PendingRun,
  RunningRun,
  FinishedRun,
  SkippedRun,
]);
export type Run = z.output<typeof Run>;
export type RunStatus = Run['status'];
export const RunStatus = z.enum(['pending', 'running', ...TerminalStatus.options, 'skipped']);

export const lastResultOf = (run: Run): TargetResult | null =>
  run.status === 'succeeded' ||
  run.status === 'failed' ||
  run.status === 'timed_out' ||
  run.status === 'cancelled'
    ? run.result
    : (run.attempts.at(-1)?.result ?? null);

export const parentSnapshotOf = (run: Run): ParentSnapshot => ({
  runId: run.id,
  jobId: run.jobId,
  jobName: run.jobName,
  status: run.status,
  result: lastResultOf(run),
});

export const currentAttempt = (run: Run): number => run.attempts.length + 1;

export const isTerminal = (run: Run): run is FinishedRun | SkippedRun => {
  switch (run.status) {
    case 'pending':
    case 'running':
      return false;
    case 'succeeded':
    case 'failed':
    case 'timed_out':
    case 'cancelled':
    case 'skipped':
      return true;
    default:
      return assertNever(run);
  }
};

export function newPendingRun(params: {
  id: RunId;
  job: Pick<Job, 'id' | 'name' | 'version' | 'groupId'>;
  sla: Pick<SlaPolicy, 'maxStartDelayMs' | 'maxDurationMs'>;
  reason: RunReason;
  scheduledAt: Date;
  availableAt?: Date;
  idempotencyKey?: string;
  parentRunId?: RunId | null;
  parent?: ParentSnapshot | null;
  now: Date;
}): PendingRun {
  const startDelay = params.sla.maxStartDelayMs;

  return {
    id: params.id,
    jobId: params.job.id,
    jobName: params.job.name,
    jobVersion: params.job.version,
    reason: params.reason,
    scheduledAt: params.scheduledAt,
    availableAt: params.availableAt ?? params.scheduledAt,
    idempotencyKey: params.idempotencyKey ?? null,
    attempts: [],
    late: false,
    lateReasons: [],
    slaDeadline:
      startDelay === undefined ? null : new Date(params.scheduledAt.getTime() + startDelay),
    slaMaxDurationMs: params.sla.maxDurationMs ?? null,
    acknowledgedAt: null,
    parentRunId: params.parent?.runId ?? params.parentRunId ?? null,
    parent: params.parent ?? null,
    groupId: params.job.groupId,
    rateLimitKey: null,
    status: 'pending',
    createdAt: params.now,
    updatedAt: params.now,
  };
}

export function startRun(
  run: PendingRun,
  p: { workerId: string; leaseMs: number; now: Date },
): RunningRun {
  const { availableAt: _availableAt, ...base } = run;

  return {
    ...base,
    status: 'running',
    startedAt: p.now,
    lease: { workerId: p.workerId, until: new Date(p.now.getTime() + p.leaseMs) },
    cancelRequested: false,
    updatedAt: p.now,
  };
}

export function renewLease(run: RunningRun, p: { leaseMs: number; now: Date }): RunningRun {
  return {
    ...run,
    lease: { ...run.lease, until: new Date(p.now.getTime() + p.leaseMs) },
    updatedAt: p.now,
  };
}

const terminalStatusFor = (result: TargetResult): TerminalStatus => {
  if (result.outcome === 'success') {
    return 'succeeded';
  }
  switch (result.error?.code) {
    case EngineErrorCode.timeout:
      return 'timed_out';
    case EngineErrorCode.cancelled:
      return 'cancelled';
    default:
      return 'failed';
  }
};

const isRetryable = (status: TerminalStatus, result: TargetResult): boolean =>
  status !== 'succeeded' && status !== 'cancelled' && result.error?.retryable !== false;

// Only the latest attempt keeps its body, keeping the doc under Mongo's 16 MiB limit.
const withoutResponseBody = (attempt: AttemptRecord): AttemptRecord => {
  const response = attempt.result.response;
  if (response?.body === undefined) {
    return attempt;
  }
  const { body: _body, ...rest } = response;

  return { ...attempt, result: { ...attempt.result, response: { ...rest, truncated: true } } };
};

export function finishAttempt(
  run: RunningRun,
  p: { result: TargetResult; retry: RetryPolicy; now: Date },
): PendingRun | FinishedRun {
  const { startedAt, lease, cancelRequested: _cancelRequested, ...base } = run;
  const attempt: AttemptRecord = {
    attempt: currentAttempt(run),
    workerId: lease.workerId,
    startedAt,
    finishedAt: p.now,
    result: p.result,
  };
  const attempts = [...run.attempts.map(withoutResponseBody), attempt];
  const status = terminalStatusFor(p.result);

  if (isRetryable(status, p.result) && attempts.length < p.retry.maxAttempts) {
    return {
      ...base,
      attempts,
      status: 'pending',
      availableAt: new Date(p.now.getTime() + computeRetryDelay(p.retry, attempts.length)),
      updatedAt: p.now,
    };
  }

  return { ...base, attempts, status, finishedAt: p.now, result: p.result, updatedAt: p.now };
}

export const expireLease = (
  run: RunningRun,
  p: { retry: RetryPolicy; now: Date },
): PendingRun | FinishedRun =>
  finishAttempt(run, {
    retry: p.retry,
    now: p.now,
    // A cancel requested before the worker died wins over retry.
    result: run.cancelRequested
      ? failedResult(
          EngineErrorCode.cancelled,
          'Cancellation requested',
          false,
          p.now.getTime() - run.startedAt.getTime(),
        )
      : {
          outcome: 'failure',
          durationMs: p.now.getTime() - run.startedAt.getTime(),
          error: {
            code: EngineErrorCode.leaseLost,
            message: `Lease held by ${run.lease.workerId} expired`,
            retryable: true,
          },
        },
  });

export function cancelPendingRun(run: PendingRun, now: Date): FinishedRun {
  const { availableAt: _availableAt, ...base } = run;

  return { ...base, status: 'cancelled', finishedAt: now, result: null, updatedAt: now };
}

export function skipRun(run: PendingRun, p: { reason: string; now: Date }): SkippedRun {
  const { availableAt: _availableAt, ...base } = run;

  return { ...base, status: 'skipped', finishedAt: p.now, skipReason: p.reason, updatedAt: p.now };
}

export function requeueClaimedRun(
  run: RunningRun,
  p: { availableAt: Date; now: Date },
): PendingRun {
  const { startedAt: _s, lease: _l, cancelRequested: _c, ...base } = run;

  return { ...base, status: 'pending', availableAt: p.availableAt, updatedAt: p.now };
}

export function skipClaimedRun(run: RunningRun, p: { reason: string; now: Date }): SkippedRun {
  const { startedAt: _s, lease: _l, cancelRequested: _c, ...base } = run;

  return { ...base, status: 'skipped', finishedAt: p.now, skipReason: p.reason, updatedAt: p.now };
}
