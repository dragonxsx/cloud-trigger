import { isDeepStrictEqual } from 'node:util';

import {
  type Clock,
  type ConfigError,
  type DomainError,
  type EventBus,
  type FinishedRun,
  type Job,
  type JobId,
  type JobRepository,
  JobSpec,
  type Logger,
  type NotFoundError,
  type PendingRun,
  type ProviderRegistry,
  type Result,
  type Run,
  type RunId,
  type RunQueue,
  type RunRepository,
  type SchedulePreview,
  type VersionConflictError,
  cancelPendingRun,
  configErrorFromZod,
  createJob,
  err,
  newJobId,
  newPendingRun,
  newRunId,
  ok,
} from '@cloud-trigger/core';

import { bindJob } from './config-validation.js';
import { upcomingFireTimes } from './fire-plan.js';
import type { RunLifecycleListener } from './lifecycle.js';
import { RunCompletion } from './run-completion.js';

export interface JobServiceDeps {
  readonly jobs: JobRepository;
  readonly runs: RunRepository;
  readonly queue: RunQueue;
  readonly events: EventBus;
  readonly registry: ProviderRegistry;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly listeners: readonly RunLifecycleListener[];
}

const notFound = (what: string, id: string): NotFoundError => ({
  code: 'not_found',
  message: `${what} ${id} not found`,
});

const scheduleChanged = (current: Job, spec: JobSpec): boolean =>
  !isDeepStrictEqual(spec.trigger, current.trigger) || spec.enabled !== current.enabled;

export class JobService {
  readonly #completion: RunCompletion;

  constructor(private readonly deps: JobServiceDeps) {
    this.#completion = new RunCompletion(deps);
  }

  validate(
    raw: unknown,
    jobId: string = 'preview',
    count = 5,
  ): Result<{ spec: JobSpec; preview: SchedulePreview }, ConfigError> {
    return this.#validate(raw, jobId, count).map(({ spec, preview }) => ({ spec, preview }));
  }

  #validate(raw: unknown, jobId: string, count: number) {
    const parsed = JobSpec.safeParse(raw);
    if (!parsed.success) {
      return err(configErrorFromZod(parsed.error));
    }
    const now = this.deps.clock.now();

    return bindJob(this.deps.registry, parsed.data).map(({ trigger }) => ({
      spec: parsed.data,
      trigger,
      preview: {
        description: trigger.describe(),
        nextFireTimes: upcomingFireTimes(trigger, { after: now, fireCount: 0, jobId })
          .take(count)
          .toArray(),
        lint: [...trigger.lint({ now })],
      },
    }));
  }

  async create(raw: unknown): Promise<Result<Job, ConfigError>> {
    const id = newJobId();
    const validated = this.validate(raw, id, 1);
    if (validated.isErr()) {
      return err(validated.error);
    }
    const { spec, preview } = validated.value;
    const job = createJob({
      id,
      spec,
      nextFireAt: preview.nextFireTimes[0] ?? null,
      now: this.deps.clock.now(),
    });
    await this.deps.jobs.insert(job);

    return ok(job);
  }

  async update(
    id: JobId,
    raw: unknown,
    expectedVersion: number,
  ): Promise<Result<Job, ConfigError | NotFoundError | VersionConflictError>> {
    const current = await this.deps.jobs.get(id);
    if (!current) {
      return err(notFound('Job', id));
    }
    const validated = this.#validate(raw, id, 1);
    if (validated.isErr()) {
      return err(validated.error);
    }
    const { spec, trigger } = validated.value;
    const now = this.deps.clock.now();

    // Use the real fire count so edits never grant extra fires or re-arm a spent `once`.
    const reschedule = scheduleChanged(current, spec)
      ? {
          nextFireAt: spec.enabled
            ? trigger.nextFireAt({
                after: now,
                lastFiredAt: current.schedule.lastFiredAt,
                fireCount: current.schedule.fireCount,
                jobId: id,
              })
            : null,
          basedOn: {
            nextFireAt: current.schedule.nextFireAt,
            fireCount: current.schedule.fireCount,
          },
        }
      : undefined;

    return this.deps.jobs.update(id, { spec, updatedAt: now, reschedule }, expectedVersion);
  }

  get(id: JobId): Promise<Job | undefined> {
    return this.deps.jobs.get(id);
  }

  async delete(id: JobId): Promise<boolean> {
    return this.deps.jobs.delete(id);
  }

  async pause(id: JobId, reason = 'Paused by user'): Promise<Result<void, NotFoundError>> {
    if (!(await this.deps.jobs.get(id))) {
      return err(notFound('Job', id));
    }
    await this.deps.jobs.patchSchedule(id, {}, { pausedReason: reason });
    await this.deps.events.publish({ type: 'job.changed', jobId: id, change: 'paused' });

    return ok(undefined);
  }

  async resume(id: JobId): Promise<Result<void, NotFoundError | ConfigError>> {
    const job = await this.deps.jobs.get(id);
    if (!job) {
      return err(notFound('Job', id));
    }
    const bound = bindJob(this.deps.registry, job);
    if (bound.isErr()) {
      return err(bound.error);
    }
    const nextFireAt = bound.value.trigger.nextFireAt({
      after: this.deps.clock.now(),
      lastFiredAt: job.schedule.lastFiredAt,
      fireCount: job.schedule.fireCount,
      jobId: id,
    });
    await this.deps.jobs.patchSchedule(
      id,
      { nextFireAt, consecutiveFailures: 0 },
      { pausedReason: null },
    );
    await this.deps.events.publish({ type: 'job.changed', jobId: id, change: 'resumed' });

    return ok(undefined);
  }

  async runNow(
    id: JobId,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<Result<PendingRun, NotFoundError | DomainError<'duplicate_run'>>> {
    const job = await this.deps.jobs.get(id);
    if (!job) {
      return err(notFound('Job', id));
    }
    const now = this.deps.clock.now();

    return this.deps.runs.insert(
      newPendingRun({
        id: newRunId(),
        job,
        reason: 'manual',
        scheduledAt: now,
        ...(opts.idempotencyKey !== undefined && {
          idempotencyKey: `manual:${id}:${opts.idempotencyKey}`,
        }),
        now,
      }),
    );
  }

  async replay(
    runId: RunId,
  ): Promise<
    Result<PendingRun, NotFoundError | DomainError<'duplicate_run'> | DomainError<'not_finished'>>
  > {
    const run = await this.deps.runs.get(runId);
    if (!run) {
      return err(notFound('Run', runId));
    }
    if (run.status === 'pending' || run.status === 'running') {
      return err({ code: 'not_finished', message: `Run ${runId} is still ${run.status}` });
    }
    const job = await this.deps.jobs.get(run.jobId);
    if (!job) {
      return err(notFound('Job', run.jobId));
    }
    const now = this.deps.clock.now();

    return this.deps.runs.insert(
      newPendingRun({ id: newRunId(), job, reason: 'replay', scheduledAt: now, now }),
    );
  }

  async cancelRun(
    runId: RunId,
  ): Promise<Result<Run, NotFoundError | DomainError<'not_cancellable'>>> {
    const run = await this.deps.runs.get(runId);
    if (!run) {
      return err(notFound('Run', runId));
    }
    switch (run.status) {
      case 'pending': {
        const cancelled: FinishedRun = cancelPendingRun(run, this.deps.clock.now());
        const job = await this.deps.jobs.get(run.jobId);
        const res = await this.#completion.commit(run, cancelled, job);

        return res.isOk() ? ok(cancelled) : this.cancelRun(runId);
      }
      case 'running':
        await this.deps.queue.requestCancel(run.id);

        return ok({ ...run, cancelRequested: true });
      default:
        return err({ code: 'not_cancellable', message: `Run ${runId} already ${run.status}` });
    }
  }
}
