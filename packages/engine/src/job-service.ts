import { isDeepStrictEqual } from 'node:util';

import {
  type BoundTrigger,
  type Clock,
  type ConnectionRepository,
  type ConfigError,
  type ConfigIssue,
  type ConflictError,
  type DecisionLog,
  type DomainError,
  type EnvironmentRepository,
  type EventBus,
  type FinishedRun,
  type GroupId,
  type GroupRepository,
  type Job,
  JobId,
  type JobRepository,
  JobSpec,
  type Logger,
  type NotFoundError,
  type PendingRun,
  type ProviderRegistry,
  type RateLimiter,
  type Result,
  type Run,
  type RunId,
  type RunQueue,
  type RunRepository,
  type SchedulePreview,
  type VersionConflictError,
  type WorkflowId,
  cancelPendingRun,
  configErrorFromZod,
  createJob,
  err,
  newJobId,
  newPendingRun,
  newRunId,
  ok,
  successDeadlineAfter,
  jobConnectionRefs,
} from '@cloud-trigger/core';

import {
  bindJob,
  inheritedNotificationIssues,
  loadConnections,
  loadTrigger,
  unknownEnvironment,
} from './config-validation.js';
import { DecisionRecorder } from './decisions.js';
import { type Explanation, explain } from './explain.js';
import { upcomingFireTimes } from './fire-plan.js';
import type { RunLifecycleListener } from './lifecycle.js';
import { PolicyResolver, rearmSuccessDeadline } from './policies.js';
import { RunCompletion } from './run-completion.js';

export interface JobServiceDeps {
  readonly jobs: JobRepository;
  readonly connections?: ConnectionRepository | undefined;
  readonly environments?: EnvironmentRepository | undefined;
  readonly runs: RunRepository;
  readonly queue: RunQueue;
  readonly events: EventBus;
  readonly registry: ProviderRegistry;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly listeners: readonly RunLifecycleListener[];
  readonly groups?: GroupRepository | undefined;
  readonly rateLimiter?: RateLimiter | undefined;
  readonly decisions?: DecisionLog | undefined;
}

export interface BackfillResult {
  readonly fireTimes: readonly Date[];
  readonly created: readonly RunId[];
  readonly duplicates: number;
  readonly truncated: boolean;
}

export interface UpcomingFire {
  readonly job: Job;
  readonly at: Date;
  readonly description: string;
}

export const backfillKey = (jobId: JobId, scheduledAt: Date) =>
  `backfill:${jobId}:${scheduledAt.toISOString()}`;

const invalidBackfill = (path: string, message: string): ConfigError => ({
  code: 'invalid_config',
  message: 'Invalid backfill request',
  issues: [{ path, message }],
});

const notFound = (what: string, id: string): NotFoundError => ({
  code: 'not_found',
  message: `${what} ${id} not found`,
});

const ownedByWorkflow = (job: Job): ConflictError => ({
  code: 'conflict',
  message: `Job ${job.id} belongs to workflow ${job.workflowId ?? ''}; edit the workflow instead`,
});

const scheduleChanged = (current: Job, spec: JobSpec): boolean =>
  !isDeepStrictEqual(spec.trigger, current.trigger) || spec.enabled !== current.enabled;

export class JobService {
  readonly #completion: RunCompletion;
  readonly #policies: PolicyResolver;
  readonly #decisions: DecisionRecorder;

  constructor(private readonly deps: JobServiceDeps) {
    this.#completion = new RunCompletion(deps);
    this.#policies = new PolicyResolver(deps.groups, deps.clock, 0);
    this.#decisions = new DecisionRecorder(deps.decisions, deps.clock, deps.logger);
  }

  async #trigger(job: Job) {
    return loadTrigger(
      this.deps.registry,
      this.deps.connections,
      job,
      await this.#policies.environment(job),
    );
  }

  async explain(id: JobId, before?: Date): Promise<Result<Explanation, NotFoundError>> {
    const job = await this.deps.jobs.get(id);
    if (!job) {
      return err(notFound('Job', id));
    }
    const now = this.deps.clock.now();
    const decisions = this.deps.decisions
      ? await this.deps.decisions.listRecent(id, { before: before ?? now, limit: 20 })
      : [];
    const bound = await this.#trigger(job);
    const wouldFireAt = bound.isOk()
      ? bound.value.nextFireAt({
          after: now,
          lastFiredAt: job.schedule.lastFiredAt,
          fireCount: job.schedule.fireCount,
          jobId: id,
        })
      : null;

    return ok(explain({ job, decisions, wouldFireAt }));
  }

  /** Group defaults were validated in the group's environment; recheck them in the job's own. */
  async #inheritedIssues(spec: JobSpec, environment: string | null): Promise<ConfigIssue[]> {
    const group = await this.#policies.group(spec.groupId);
    if (!group || group.environment === environment) {
      return [];
    }
    const issues = await inheritedNotificationIssues(
      this.deps.registry,
      this.deps.connections,
      group,
      environment,
    );

    return issues.map((issue) => ({
      path: 'groupId',
      message: `Group "${group.name}" default notification breaks in environment "${environment ?? 'base'}": ${issue.path}: ${issue.message}`,
    }));
  }

  async #checkGroup(spec: JobSpec): Promise<Result<void, ConfigError>> {
    if (spec.groupId === null || !this.deps.groups) {
      return ok(undefined);
    }
    if (await this.deps.groups.get(spec.groupId)) {
      return ok(undefined);
    }

    return err({
      code: 'invalid_config',
      message: 'Invalid job configuration',
      issues: [{ path: 'groupId', message: `Group ${spec.groupId} does not exist` }],
    });
  }

  async #checkUpstream(
    jobId: JobId,
    trigger: BoundTrigger,
  ): Promise<Result<readonly JobId[], ConfigError>> {
    const issues: ConfigIssue[] = [];
    const upstream: JobId[] = [];
    for (const ref of trigger.upstream?.() ?? []) {
      const path = `trigger.config.${ref.path}`;
      const parentId = JobId.safeParse(ref.jobId);
      if (!parentId.success) {
        issues.push({ path, message: 'Not a job id' });
      } else if (parentId.data === jobId) {
        issues.push({ path, message: 'A job cannot run after itself' });
      } else {
        const parent = await this.deps.jobs.get(parentId.data);
        if (!parent) {
          issues.push({ path, message: `Job ${parentId.data} does not exist` });
        } else if (await this.#dependsOn(parent, jobId)) {
          issues.push({
            path,
            message: `Creates a cycle: "${parent.name}" already runs after this job`,
          });
        } else {
          upstream.push(parent.id);
        }
      }
    }

    return issues.length === 0
      ? ok(upstream)
      : err({ code: 'invalid_config', message: 'Invalid job configuration', issues });
  }

  async #dependsOn(job: Job, ancestor: JobId): Promise<boolean> {
    const seen = new Set<JobId>([job.id]);
    const stack = [...job.upstreamJobIds];
    for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
      if (id === ancestor) {
        return true;
      }
      if (!seen.has(id)) {
        seen.add(id);
        stack.push(...((await this.deps.jobs.get(id))?.upstreamJobIds ?? []));
      }
    }

    return false;
  }

  async dependencies(id: JobId): Promise<{ upstream: readonly Job[]; downstream: readonly Job[] }> {
    const job = await this.deps.jobs.get(id);
    if (!job) {
      return { upstream: [], downstream: [] };
    }
    const upstream = await Promise.all(
      job.upstreamJobIds.map((parent) => this.deps.jobs.get(parent)),
    );

    return {
      upstream: upstream.filter((parent) => parent !== undefined),
      downstream: await this.deps.jobs.findDependants(id),
    };
  }

  async validate(
    raw: unknown,
    jobId: string = 'preview',
    count = 5,
  ): Promise<Result<{ spec: JobSpec; preview: SchedulePreview }, ConfigError>> {
    return (await this.#validate(raw, jobId, count)).map(({ spec, preview }) => ({
      spec,
      preview,
    }));
  }

  async #validate(raw: unknown, jobId: string, count: number) {
    const parsed = JobSpec.safeParse(raw);
    if (!parsed.success) {
      return err(configErrorFromZod(parsed.error));
    }
    const unknown = await unknownEnvironment(this.deps.environments, parsed.data.environment);
    if (unknown.length > 0) {
      return err<never, ConfigError>({
        code: 'invalid_config',
        message: 'Invalid job configuration',
        issues: unknown,
      });
    }
    const environment = await this.#policies.environment(parsed.data);
    const inherited = await this.#inheritedIssues(parsed.data, environment);
    if (inherited.length > 0) {
      return err<never, ConfigError>({
        code: 'invalid_config',
        message: 'Invalid job configuration',
        issues: inherited,
      });
    }
    const connectionRefs = jobConnectionRefs(this.deps.registry, parsed.data);
    const connections = await loadConnections(this.deps.connections, connectionRefs, environment);
    const now = this.deps.clock.now();

    return bindJob(this.deps.registry, parsed.data, connections).map(({ trigger }) => ({
      spec: parsed.data,
      trigger,
      connectionRefs,
      preview: {
        description: trigger.describe(),
        nextFireTimes: upcomingFireTimes(trigger, { after: now, fireCount: 0, jobId })
          .take(count)
          .toArray(),
        lint: [...trigger.lint({ now })],
      },
    }));
  }

  async create(
    raw: unknown,
    opts: { readonly workflowId?: WorkflowId | undefined } = {},
  ): Promise<Result<Job, ConfigError>> {
    const id = newJobId();
    const validated = await this.#validate(raw, id, 1);
    if (validated.isErr()) {
      return err(validated.error);
    }
    const { spec, preview, trigger, connectionRefs } = validated.value;
    const group = await this.#checkGroup(spec);
    if (group.isErr()) {
      return err(group.error);
    }
    const upstream = await this.#checkUpstream(id, trigger);
    if (upstream.isErr()) {
      return err(upstream.error);
    }
    const now = this.deps.clock.now();
    const { policy } = await this.#policies.resolve(spec);
    const job = createJob({
      id,
      spec,
      nextFireAt: preview.nextFireTimes[0] ?? null,
      successDeadline: successDeadlineAfter(now, policy.sla.maxSinceLastSuccessMs),
      upstreamJobIds: upstream.value,
      connectionRefs,
      eventSource: trigger.source ? spec.trigger.type : null,
      workflowId: opts.workflowId ?? null,
      now,
    });
    await this.deps.jobs.insert(job);

    return ok(job);
  }

  async update(
    id: JobId,
    raw: unknown,
    expectedVersion: number,
    opts: { readonly asWorkflow?: boolean } = {},
  ): Promise<Result<Job, ConfigError | NotFoundError | VersionConflictError | ConflictError>> {
    const current = await this.deps.jobs.get(id);
    if (!current) {
      return err(notFound('Job', id));
    }
    if (current.workflowId !== null && opts.asWorkflow !== true) {
      return err(ownedByWorkflow(current));
    }
    const validated = await this.#validate(raw, id, 1);
    if (validated.isErr()) {
      return err(validated.error);
    }
    const { spec, trigger, connectionRefs } = validated.value;
    const group = await this.#checkGroup(spec);
    if (group.isErr()) {
      return err(group.error);
    }
    const upstream = await this.#checkUpstream(id, trigger);
    if (upstream.isErr()) {
      return err(upstream.error);
    }
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

    const updated = await this.deps.jobs.update(
      id,
      {
        spec,
        updatedAt: now,
        reschedule,
        upstreamJobIds: upstream.value,
        connectionRefs,
        eventSource: trigger.source ? spec.trigger.type : null,
      },
      expectedVersion,
    );
    if (updated.isErr()) {
      return updated;
    }
    if (current.enabled && !spec.enabled) {
      await this.#decisions.record({
        jobId: id,
        fireTime: current.schedule.nextFireAt,
        decision: 'disabled',
        detail: 'Disabled by an edit',
      });
    }
    const [before, after] = await Promise.all([
      this.#policies.resolve(current),
      this.#policies.resolve(updated.value),
    ]);
    const slaLimit = after.policy.sla.maxSinceLastSuccessMs;
    if (slaLimit === before.policy.sla.maxSinceLastSuccessMs) {
      return updated;
    }
    const successDeadline = await rearmSuccessDeadline(this.deps.jobs, current, slaLimit, now);

    return ok({
      ...updated.value,
      slaBreachedAt: null,
      schedule: { ...updated.value.schedule, successDeadline },
    });
  }

  get(id: JobId): Promise<Job | undefined> {
    return this.deps.jobs.get(id);
  }

  async delete(
    id: JobId,
    opts: { readonly asWorkflow?: boolean } = {},
  ): Promise<Result<boolean, ConflictError>> {
    const current = await this.deps.jobs.get(id);
    if (current && current.workflowId !== null && opts.asWorkflow !== true) {
      return err(ownedByWorkflow(current));
    }

    return ok(await this.deps.jobs.delete(id));
  }

  async pause(id: JobId, reason = 'Paused by user'): Promise<Result<void, NotFoundError>> {
    if (!(await this.deps.jobs.get(id))) {
      return err(notFound('Job', id));
    }
    await this.deps.jobs.patchSchedule(id, {}, { pausedReason: reason });
    await this.#decisions.record({ jobId: id, fireTime: null, decision: 'paused', detail: reason });
    await this.deps.events.publish({ type: 'job.changed', jobId: id, change: 'paused' });

    return ok(undefined);
  }

  async resume(id: JobId): Promise<Result<void, NotFoundError | ConfigError>> {
    const job = await this.deps.jobs.get(id);
    if (!job) {
      return err(notFound('Job', id));
    }
    const bound = await this.#trigger(job);
    if (bound.isErr()) {
      return err(bound.error);
    }
    const nextFireAt = bound.value.nextFireAt({
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
        sla: (await this.#policies.resolve(job)).policy.sla,
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
      newPendingRun({
        id: newRunId(),
        job,
        reason: 'replay',
        scheduledAt: now,
        parentRunId: run.parentRunId,
        parent: run.parent,
        sla: (await this.#policies.resolve(job)).policy.sla,
        now,
      }),
    );
  }

  async backfill(
    id: JobId,
    p: { from: Date; to: Date; maxRuns: number; dryRun: boolean },
  ): Promise<Result<BackfillResult, NotFoundError | ConfigError>> {
    const job = await this.deps.jobs.get(id);
    if (!job) {
      return err(notFound('Job', id));
    }
    if (p.to.getTime() <= p.from.getTime()) {
      return err(invalidBackfill('to', 'Must be after "from"'));
    }
    const bound = await this.#trigger(job);
    if (bound.isErr()) {
      return err(bound.error);
    }
    const trigger = bound.value;
    if (trigger.matches) {
      return err(invalidBackfill('trigger', 'Event-triggered jobs have no schedule to backfill'));
    }
    const fireTimes: Date[] = [];
    let truncated = false;
    for (const at of upcomingFireTimes(trigger, {
      after: new Date(p.from.getTime() - 1),
      fireCount: 0,
      jobId: id,
    })) {
      if (at.getTime() > p.to.getTime()) {
        break;
      }
      if (fireTimes.length === p.maxRuns) {
        truncated = true;
        break;
      }
      fireTimes.push(at);
    }
    if (p.dryRun) {
      return ok({ fireTimes, created: [], duplicates: 0, truncated });
    }
    const now = this.deps.clock.now();
    const { policy } = await this.#policies.resolve(job);
    const created: RunId[] = [];
    for (const scheduledAt of fireTimes) {
      const inserted = await this.deps.runs.insert(
        newPendingRun({
          id: newRunId(),
          job,
          reason: 'backfill',
          scheduledAt,
          availableAt: now,
          idempotencyKey: backfillKey(id, scheduledAt),
          sla: { maxDurationMs: policy.sla.maxDurationMs },
          now,
        }),
        { durableKey: true },
      );
      if (inserted.isOk()) {
        created.push(inserted.value.id);
      }
    }

    return ok({ fireTimes, created, duplicates: fireTimes.length - created.length, truncated });
  }

  async upcoming(p: {
    tag?: string | undefined;
    groupId?: GroupId | undefined;
    from: Date;
    until: Date;
    cap: number;
  }): Promise<UpcomingFire[]> {
    const fires: UpcomingFire[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.deps.jobs.list({
        tag: p.tag,
        groupId: p.groupId,
        enabled: true,
        limit: 200,
        cursor,
      });
      for (const job of page.items.filter((j) => j.pausedReason === null)) {
        const bound = await this.#trigger(job);
        if (bound.isErr() || bound.value.matches) {
          continue;
        }
        const trigger = bound.value;
        const times = upcomingFireTimes(trigger, {
          after: p.from,
          fireCount: job.schedule.fireCount,
          lastFiredAt: job.schedule.lastFiredAt,
          jobId: job.id,
        })
          .take(p.cap)
          .filter((at) => at.getTime() <= p.until.getTime());
        for (const at of times) {
          fires.push({ job, at, description: trigger.describe() });
        }
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    return fires.toSorted((a, b) => a.at.getTime() - b.at.getTime()).slice(0, p.cap);
  }

  async replayMany(
    runIds: readonly RunId[],
  ): Promise<{ runId: RunId; newRunId: RunId | null; error: string | null }[]> {
    const results = [];
    for (const runId of runIds) {
      const replayed = await this.replay(runId);
      results.push(
        replayed.isOk()
          ? { runId, newRunId: replayed.value.id, error: null }
          : { runId, newRunId: null, error: replayed.error.message },
      );
    }

    return results;
  }

  acknowledge(runIds: readonly RunId[]): Promise<number> {
    return this.deps.runs.acknowledge(runIds, this.deps.clock.now());
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
