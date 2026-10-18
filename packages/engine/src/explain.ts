import { type Job, type ScheduleDecision, assertNever } from '@cloud-trigger/core';

export interface Explanation {
  readonly narrative: readonly string[];
  readonly nextFireAt: Date | null;
  readonly decisions: readonly ScheduleDecision[];
}

const clock = (at: Date): string => `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

const latest = (decisions: readonly ScheduleDecision[], kind: ScheduleDecision['decision']) =>
  decisions.find((d) => d.decision === kind);

const describeDecision = (d: ScheduleDecision): string => {
  const about = d.fireTime ? ` scheduled for ${clock(d.fireTime)}` : '';
  switch (d.decision) {
    case 'overlap_skipped':
      return `At ${clock(d.at)} the run${about} was skipped because the previous run was still active (${d.detail}).`;
    case 'misfire_skipped':
      return `At ${clock(d.at)} missed fire times were dropped: ${d.detail}.`;
    case 'catchup':
      return `At ${clock(d.at)} the scheduler caught up: ${d.detail}.`;
    case 'rate_limited':
      return `At ${clock(d.at)} the run${about} waited for its group's rate limit.`;
    case 'paused':
      return `At ${clock(d.at)} the job was paused: ${d.detail}.`;
    case 'disabled':
      return `At ${clock(d.at)} the job was disabled.`;
    case 'finished':
      return `At ${clock(d.at)} the schedule ran out: ${d.detail}.`;
    case 'fired':
      return `At ${clock(d.at)} the job fired the run${about}.`;
    default:
      return assertNever(d.decision);
  }
};

export function explain(p: {
  job: Job;
  decisions: readonly ScheduleDecision[];
  wouldFireAt: Date | null;
}): Explanation {
  const { job, decisions, wouldFireAt } = p;
  const narrative: string[] = [];
  const next = wouldFireAt ? ` Its next fire would be ${clock(wouldFireAt)}.` : '';
  if (!job.enabled) {
    const since = latest(decisions, 'disabled');
    narrative.push(
      `Disabled${since ? ` since ${clock(since.at)}` : ''}, so it does not run.${next}`,
    );
  } else if (job.pausedReason !== null) {
    const since = latest(decisions, 'paused');
    narrative.push(
      `Paused${since ? ` since ${clock(since.at)}` : ''}: ${job.pausedReason}. Resume it to schedule runs again.${next}`,
    );
  } else if (job.upstreamJobIds.length > 0) {
    narrative.push('Runs only when its upstream job finishes; it has no schedule of its own.');
  } else if (job.schedule.nextFireAt === null) {
    narrative.push('Its schedule has no further fire times, so it will not run again.');
  } else {
    narrative.push(`Scheduled; the next run is due at ${clock(job.schedule.nextFireAt)}.`);
  }
  if (job.schedule.consecutiveFailures > 0) {
    narrative.push(`The last ${job.schedule.consecutiveFailures} run(s) failed in a row.`);
  }
  const notable = decisions.find(
    (d) => d.decision !== 'paused' && d.decision !== 'disabled' && d.decision !== 'fired',
  );
  if (notable) {
    narrative.push(describeDecision(notable));
  }

  return {
    narrative,
    nextFireAt: job.enabled && job.pausedReason === null ? job.schedule.nextFireAt : wouldFireAt,
    decisions,
  };
}
