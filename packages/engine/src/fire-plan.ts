import {
  type BoundTrigger,
  type Job,
  type MisfirePolicy,
  type RunReason,
  type TriggerContext,
  assertNever,
} from '@cloud-trigger/core';

export interface PlannedFire {
  readonly scheduledAt: Date;
  readonly reason: Extract<RunReason, 'scheduled' | 'catchup'>;
}

export interface FirePlan {
  readonly fires: readonly PlannedFire[];
  readonly skippedCount: number;
  readonly nextFireAt: Date | null;
}

export function* upcomingFireTimes(
  trigger: BoundTrigger,
  start: Omit<TriggerContext, 'lastFiredAt'> & { readonly lastFiredAt?: Date | null },
): Generator<Date, void> {
  let ctx: TriggerContext = { lastFiredAt: null, ...start };
  for (;;) {
    const next = trigger.nextFireAt(ctx);
    if (next === null) {
      return;
    }
    yield next;
    ctx = { ...ctx, after: next, lastFiredAt: next, fireCount: ctx.fireCount + 1 };
  }
}

const isDue = (fireAt: Date | null, now: Date): fireAt is Date =>
  fireAt !== null && fireAt.getTime() <= now.getTime();

interface DueFireTimes {
  readonly missed: readonly Date[];
  /** Latest missed fire, even when `missed` was capped. */
  readonly latestMissed: Date | undefined;
  readonly onTime: readonly Date[];
  readonly following: Date | null;
}

/** Binary search: `nextFireAt` is monotonic in `after`. */
function latestFireBefore(
  trigger: BoundTrigger,
  bound: Date,
  known: Date,
  contextAfter: (after: Date) => TriggerContext,
): Date {
  let latest = known;
  let low = known.getTime();
  let high = bound.getTime() - 1;
  while (low <= high) {
    const mid = low + Math.floor((high - low) / 2);
    const fire = trigger.nextFireAt(contextAfter(new Date(mid)));
    if (fire !== null && fire.getTime() < bound.getTime()) {
      latest = fire;
      low = fire.getTime();
    } else {
      high = mid - 1;
    }
  }

  return latest;
}

function collectDueFireTimes(
  job: Pick<Job, 'id' | 'schedule'>,
  first: Date,
  trigger: BoundTrigger,
  p: { now: Date; graceStart: Date; maxCatchup: number; countMissed: boolean },
): DueFireTimes {
  let consumed = 0;
  let lastFiredAt: Date | null = null;
  const contextAfter = (after: Date): TriggerContext => ({
    after,
    lastFiredAt,
    fireCount: job.schedule.fireCount + consumed,
    jobId: job.id,
  });
  // Only fires that will run consume the trigger's budget (`maxCount`), so skipped ones don't.
  const advance = (fire: Date, counts = true): Date | null => {
    if (counts) {
      consumed++;
    }
    lastFiredAt = fire;

    return trigger.nextFireAt(contextAfter(fire));
  };
  const isMissed = (t: Date) => t.getTime() < p.graceStart.getTime();

  const missed: Date[] = [];
  let next: Date | null = first;
  while (next !== null && isMissed(next) && missed.length < p.maxCatchup) {
    missed.push(next);
    next = advance(next, p.countMissed);
  }
  let latestMissed = missed.at(-1);
  if (next !== null && isMissed(next)) {
    latestMissed = latestFireBefore(trigger, p.graceStart, next, contextAfter);
    lastFiredAt = latestMissed;
    next = trigger.nextFireAt(contextAfter(new Date(p.graceStart.getTime() - 1)));
  }

  const onTime: Date[] = [];
  while (isDue(next, p.now) && onTime.length < p.maxCatchup) {
    onTime.push(next);
    next = advance(next);
  }
  if (isDue(next, p.now)) {
    onTime[onTime.length - 1] = latestFireBefore(
      trigger,
      new Date(p.now.getTime() + 1),
      next,
      contextAfter,
    );
    next = trigger.nextFireAt(contextAfter(p.now));
  }

  return { missed, latestMissed, onTime, following: next };
}

function catchupFires(mode: MisfirePolicy['mode'], due: DueFireTimes): PlannedFire[] {
  switch (mode) {
    case 'skip':
      return [];
    case 'run_once': {
      const latest = due.latestMissed;

      return latest && due.onTime.length === 0 ? [{ scheduledAt: latest, reason: 'catchup' }] : [];
    }
    case 'run_all':
      return due.missed.map((t) => ({ scheduledAt: t, reason: 'catchup' }));
    default:
      return assertNever(mode);
  }
}

export function planFires(p: {
  job: Pick<Job, 'id' | 'schedule'>;
  trigger: BoundTrigger;
  misfire: MisfirePolicy;
  now: Date;
}): FirePlan {
  const { job, trigger, misfire, now } = p;
  const first = job.schedule.nextFireAt;
  if (!isDue(first, now)) {
    return { fires: [], skippedCount: 0, nextFireAt: first };
  }

  const due = collectDueFireTimes(job, first, trigger, {
    now,
    graceStart: new Date(now.getTime() - misfire.graceMs),
    maxCatchup: misfire.maxCatchup,
    countMissed: misfire.mode === 'run_all',
  });
  const catchup = catchupFires(misfire.mode, due);
  const fires = [
    ...catchup,
    ...due.onTime.map((t): PlannedFire => ({ scheduledAt: t, reason: 'scheduled' })),
  ];
  // run_once catch-up wasn't counted during enumeration; recompute next fire with it.
  const runOnce = misfire.mode === 'run_once' ? catchup[0] : undefined;
  const nextFireAt = runOnce
    ? trigger.nextFireAt({
        after: runOnce.scheduledAt,
        lastFiredAt: runOnce.scheduledAt,
        fireCount: job.schedule.fireCount + fires.length,
        jobId: job.id,
      })
    : due.following;

  return {
    fires,
    skippedCount: due.missed.length + due.onTime.length - fires.length,
    nextFireAt,
  };
}

export function jitteredAvailableAt(
  scheduledAt: Date,
  jitterMs: number,
  nextFireAt: Date | null,
  random: () => number = Math.random,
): Date {
  if (jitterMs <= 0) {
    return scheduledAt;
  }
  const room = nextFireAt
    ? Math.max(0, nextFireAt.getTime() - scheduledAt.getTime() - 1)
    : jitterMs;

  return new Date(scheduledAt.getTime() + Math.floor(random() * Math.min(jitterMs, room)));
}
