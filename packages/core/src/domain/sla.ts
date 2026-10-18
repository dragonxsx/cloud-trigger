import type { Job } from './job.js';
import type { SlaPolicy } from './policy.js';
import type { PendingRun, RunningRun } from './run.js';

export interface SlaCheck {
  readonly reasons: readonly string[];
  readonly nextDeadline: Date | null;
}

const plus = (at: Date, ms: number) => new Date(at.getTime() + ms);

export function checkRunSla(run: PendingRun | RunningRun, sla: SlaPolicy, now: Date): SlaCheck {
  const startBy =
    sla.maxStartDelayMs === undefined ? null : plus(run.scheduledAt, sla.maxStartDelayMs);
  if (run.status === 'pending') {
    return startBy !== null && now >= startBy
      ? {
          reasons: [`Not started within ${sla.maxStartDelayMs} ms of its scheduled time`],
          nextDeadline: null,
        }
      : { reasons: [], nextDeadline: startBy };
  }
  const reasons: string[] = [];
  if (startBy !== null && run.startedAt > startBy) {
    reasons.push(
      `Started ${run.startedAt.getTime() - run.scheduledAt.getTime()} ms after its scheduled time`,
    );
  }
  const finishBy = sla.maxDurationMs === undefined ? null : plus(run.startedAt, sla.maxDurationMs);
  if (finishBy !== null && now >= finishBy) {
    reasons.push(`Still running after ${sla.maxDurationMs} ms`);
  }

  return reasons.length > 0 ? { reasons, nextDeadline: null } : { reasons, nextDeadline: finishBy };
}

export function checkJobSla(
  job: Pick<Job, 'schedule' | 'createdAt'>,
  sla: SlaPolicy,
  now: Date,
): SlaCheck {
  if (sla.maxSinceLastSuccessMs === undefined) {
    return { reasons: [], nextDeadline: null };
  }
  const since = job.schedule.lastSuccessAt ?? job.createdAt;
  const deadline = plus(since, sla.maxSinceLastSuccessMs);

  return now >= deadline
    ? {
        reasons: [
          job.schedule.lastSuccessAt
            ? `No successful run for more than ${sla.maxSinceLastSuccessMs} ms`
            : `No successful run within ${sla.maxSinceLastSuccessMs} ms of creation`,
        ],
        nextDeadline: null,
      }
    : { reasons: [], nextDeadline: deadline };
}
