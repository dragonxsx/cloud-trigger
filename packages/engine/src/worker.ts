import {
  assertNever,
  type BoundInput,
  type BoundTarget,
  type Clock,
  type DecisionLog,
  EngineErrorCode,
  type GroupId,
  type RateLimit,
  type FinishedRun,
  type GroupRepository,
  type Job,
  type JobPolicy,
  type JobRepository,
  type Logger,
  type ParentSnapshot,
  type PendingRun,
  type ProviderRegistry,
  type RateLimiter,
  type Run,
  type RunContext,
  type RunQueue,
  type RunRepository,
  type RunningRun,
  type SecretResolver,
  type SkippedRun,
  type TargetResult,
  type Tracer,
  ResultAsync,
  abortedResult,
  currentAttempt,
  failedResult,
  finishAttempt,
  noRetry,
  noopTracer,
  parentSnapshotOf,
  requeueClaimedRun,
  skipClaimedRun,
  toError,
} from '@cloud-trigger/core';

import { bindJob } from './config-validation.js';
import { DecisionRecorder } from './decisions.js';
import type { RunLifecycleListener } from './lifecycle.js';
import { PollingLoop } from './loop.js';
import { PolicyResolver, rateLimitKey } from './policies.js';
import { RunCompletion } from './run-completion.js';

export interface WorkerOptions {
  readonly workerId: string;
  readonly concurrency: number;
  readonly pollIntervalMs: number;
  readonly leaseMs: number;
  readonly bufferedRequeueDelayMs: number;
}

export interface WorkerDeps {
  readonly jobs: JobRepository;
  readonly runs: RunRepository;
  readonly queue: RunQueue;
  readonly registry: ProviderRegistry;
  readonly secrets: SecretResolver;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly listeners: readonly RunLifecycleListener[];
  readonly groups?: GroupRepository | undefined;
  readonly rateLimiter?: RateLimiter | undefined;
  readonly decisions?: DecisionLog | undefined;
  readonly tracer?: Tracer | undefined;
}

class CancelledError extends Error {
  override readonly name = 'CancelledError';
}

// Only `replace` orders by claim time; a misorder costs brief overlap, never concurrency.
const hasOlderClaim = (a: Run, b: RunningRun): boolean =>
  a.status === 'running' &&
  (a.startedAt.getTime() < b.startedAt.getTime() ||
    (a.startedAt.getTime() === b.startedAt.getTime() && a.id < b.id));

type OverlapDecision =
  | { action: 'run' }
  | { action: 'skip'; reason: string }
  | { action: 'buffer' }
  | { action: 'wait' };

export class Worker {
  readonly #loop: PollingLoop;
  readonly #inFlight = new Set<Promise<void>>();
  readonly #completion: RunCompletion;
  readonly #policies: PolicyResolver;
  readonly #decisions: DecisionRecorder;
  readonly #throttledRuns = new Set<string>();

  constructor(
    private readonly deps: WorkerDeps,
    private readonly options: WorkerOptions,
  ) {
    this.#loop = new PollingLoop('worker', options.pollIntervalMs, () => this.tick(), deps.logger);
    this.#completion = new RunCompletion(deps);
    this.#policies = new PolicyResolver(deps.groups, deps.clock);
    this.#decisions = new DecisionRecorder(deps.decisions, deps.clock, deps.logger);
  }

  #overlapSkipped(run: RunningRun, detail: string): Promise<void> {
    return this.#decisions.record({
      jobId: run.jobId,
      runId: run.id,
      fireTime: run.scheduledAt,
      decision: 'overlap_skipped',
      detail,
    });
  }

  get activeRuns(): number {
    return this.#inFlight.size;
  }

  start(): void {
    this.#loop.start();
  }

  async stop(): Promise<void> {
    await this.#loop.stop();
    await Promise.allSettled(this.#inFlight);
  }

  async tick(): Promise<boolean> {
    let claimed = 0;
    while (this.#inFlight.size < this.options.concurrency) {
      const run = await this.deps.queue.claimNext({
        workerId: this.options.workerId,
        now: this.deps.clock.now(),
        leaseMs: this.options.leaseMs,
      });
      if (!run) {
        return false;
      }
      claimed++;
      const task = this.process(run)
        .catch((error: unknown) =>
          this.deps.logger.error('Run processing crashed', { runId: run.id, err: error }),
        )
        .finally(() => this.#inFlight.delete(task));
      this.#inFlight.add(task);
    }
    if (this.#inFlight.size > 0) {
      await Promise.race(this.#inFlight);
    }

    return claimed > 0;
  }

  async process(initial: RunningRun): Promise<void> {
    let claimed = initial;
    const job = await this.deps.jobs.get(claimed.jobId);
    if (!job) {
      await this.#finish(
        claimed,
        failedResult('job_deleted', 'Job no longer exists', false),
        undefined,
        undefined,
      );

      return;
    }

    const resolved = await this.#policies.resolve(job);
    const decision = await this.#overlapDecision(job, resolved.policy, claimed);
    switch (decision.action) {
      case 'skip':
        await this.#commit(
          claimed,
          skipClaimedRun(claimed, { reason: decision.reason, now: this.deps.clock.now() }),
          job,
        );
        await this.#overlapSkipped(claimed, decision.reason);

        return;
      case 'wait': {
        const now = this.deps.clock.now();
        await this.#commit(
          claimed,
          requeueClaimedRun(claimed, {
            availableAt: new Date(now.getTime() + this.options.bufferedRequeueDelayMs),
            now,
          }),
          job,
        );

        return;
      }
      case 'buffer': {
        const now = this.deps.clock.now();
        const buffered = await this.deps.queue.buffer(
          claimed,
          requeueClaimedRun(claimed, {
            availableAt: new Date(now.getTime() + this.options.bufferedRequeueDelayMs),
            now,
          }),
        );
        if (buffered.isOk()) {
          return;
        }
        if (buffered.error.code === 'buffer_full') {
          const reason = 'overlap: buffer_one (buffer already full)';
          await this.#commit(
            claimed,
            skipClaimedRun(claimed, { reason, now: this.deps.clock.now() }),
            job,
          );
          await this.#overlapSkipped(claimed, reason);
        } else {
          this.deps.logger.warn('Run changed concurrently; dropping update', { runId: claimed.id });
        }

        return;
      }
      case 'run':
        break;
    }

    if (resolved.rateLimit && job.groupId !== null && this.deps.rateLimiter) {
      const throttled = await this.#throttle(claimed, job, resolved.rateLimit, job.groupId);
      if (throttled === undefined) {
        return;
      }
      claimed = throttled;
    }

    const bound = bindJob(this.deps.registry, job);
    if (bound.isErr()) {
      const message = bound.error.issues.map((i) => `${i.path}: ${i.message}`).join('; ');
      await this.#finish(
        claimed,
        failedResult(EngineErrorCode.configInvalid, message, false),
        job,
        resolved.policy,
      );

      return;
    }
    await this.#execute(claimed, job, resolved.policy, bound.value.input, bound.value.target);
  }

  async #throttle(
    claimed: RunningRun,
    job: Job,
    limit: RateLimit,
    groupId: GroupId,
  ): Promise<RunningRun | undefined> {
    const limiter = this.deps.rateLimiter;
    if (!limiter) {
      return claimed;
    }
    const key = rateLimitKey(groupId);
    const now = this.deps.clock.now();
    const acquired = await limiter.tryAcquire(key, limit, now);
    if (!acquired.ok) {
      this.deps.logger.debug('Rate limited; requeueing run', { runId: claimed.id, key });
      if (!this.#throttledRuns.has(claimed.id)) {
        if (this.#throttledRuns.size >= 1_000) {
          this.#throttledRuns.clear();
        }
        this.#throttledRuns.add(claimed.id);
        await this.#decisions.record({
          jobId: job.id,
          runId: claimed.id,
          fireTime: claimed.scheduledAt,
          decision: 'rate_limited',
          detail: `Group rate limit reached; waiting (next try ${acquired.retryAt.toISOString()})`,
        });
      }
      await this.#commit(
        claimed,
        requeueClaimedRun(claimed, { availableAt: acquired.retryAt, now }),
        job,
      );

      return undefined;
    }
    if (!acquired.holdsSlot) {
      return claimed;
    }
    if (!(await this.deps.runs.markSlotHeld(claimed, key))) {
      await limiter.release(key, this.deps.clock.now());

      return undefined;
    }

    return { ...claimed, rateLimitKey: key };
  }

  async #overlapDecision(
    job: Job,
    jobPolicy: JobPolicy,
    run: RunningRun,
  ): Promise<OverlapDecision> {
    const policy = jobPolicy.overlap;
    switch (policy) {
      case 'allow':
        return { action: 'run' };
      // Exclusion via the store's execution slot; claim timestamps disagree across replicas.
      case 'forbid':
      case 'buffer_one':
        if (await this.deps.queue.acquireExecution(run)) {
          return { action: 'run' };
        }
        if (run.reason === 'backfill' || run.reason === 'event' || run.reason === 'workflow') {
          return { action: 'wait' };
        }

        return policy === 'forbid'
          ? { action: 'skip', reason: 'overlap: forbid (previous run still active)' }
          : { action: 'buffer' };
      case 'replace': {
        const olderRunning = (await this.deps.runs.findByStatus(job.id, ['running'])).filter(
          (r) => r.id !== run.id && hasOlderClaim(r, run),
        );
        await Promise.all(olderRunning.map((r) => this.deps.queue.requestCancel(r.id)));

        return { action: 'run' };
      }
      default:
        return assertNever(policy);
    }
  }

  async #execute(
    claimed: RunningRun,
    job: Job,
    policy: JobPolicy,
    input: BoundInput,
    target: BoundTarget,
  ): Promise<void> {
    let current = claimed;
    let leaseLost = false;
    const cancel = new AbortController();
    const signal = AbortSignal.any([AbortSignal.timeout(policy.timeoutMs), cancel.signal]);

    const beat = async (): Promise<void> => {
      const until = new Date(this.deps.clock.now().getTime() + this.options.leaseMs);
      try {
        const { renewed, cancelRequested } = await this.deps.queue.renewLease({
          runId: current.id,
          workerId: this.options.workerId,
          until,
        });
        if (!renewed) {
          leaseLost = true;
          cancel.abort(new CancelledError('Lease lost'));

          return;
        }
        current = { ...current, lease: { ...current.lease, until } };
        if (cancelRequested) {
          cancel.abort(new CancelledError('Cancellation requested'));
        }
      } catch (error: unknown) {
        this.deps.logger.warn('Lease renewal failed', { runId: current.id, err: error });
      }
    };
    // Await renewals before completion, else `lease.until` drifts and the CAS fails.
    let beating: Promise<void> | undefined;
    const heartbeat = setInterval(
      () => {
        beating ??= beat().finally(() => {
          beating = undefined;
        });
      },
      Math.max(250, Math.floor(this.options.leaseMs / 3)),
    );

    const parent = claimed.parent ?? (await this.#legacyParent(claimed));
    const span = (this.deps.tracer ?? noopTracer).startRun({
      jobId: job.id,
      jobName: job.name,
      runId: claimed.id,
      attempt: currentAttempt(claimed),
      reason: claimed.reason,
      parentTraceparent: claimed.event?.headers['traceparent'],
    });
    const ctx: RunContext = {
      ...(parent && { parent }),
      runId: claimed.id,
      jobId: job.id,
      jobName: job.name,
      attempt: currentAttempt(claimed),
      scheduledAt: claimed.scheduledAt,
      reason: claimed.reason,
      secrets: this.deps.secrets,
      now: this.deps.clock.now(),
      ...(span.traceparent !== undefined && { traceparent: span.traceparent }),
      ...(claimed.idempotencyKey !== null && { idempotencyKey: claimed.idempotencyKey }),
      ...(claimed.event !== null && { trigger: { event: claimed.event } }),
    };

    let result: TargetResult;
    const started = performance.now();
    try {
      result = await this.#settleOnAbort(signal, async () => {
        const payload = await ResultAsync.fromPromise(input.resolve(ctx), toError);
        if (payload.isErr()) {
          return failedResult(EngineErrorCode.inputFailed, payload.error.message, false);
        }

        return target.execute({ payload: payload.value, ctx, signal });
      });
    } catch (error: unknown) {
      result = failedResult(
        EngineErrorCode.unexpected,
        toError(error).message,
        true,
        performance.now() - started,
      );
    } finally {
      clearInterval(heartbeat);
      await beating;
    }
    span.end({ outcome: result.outcome, errorCode: result.error?.code });

    if (leaseLost) {
      this.deps.logger.warn('Discarding result: lease lost (run was reclaimed)', {
        runId: claimed.id,
      });

      return;
    }
    await this.#finish(current, result, job, policy);
  }

  #settleOnAbort(signal: AbortSignal, work: () => Promise<TargetResult>): Promise<TargetResult> {
    const started = performance.now();
    const aborted = new Promise<TargetResult>((resolve) => {
      const onAbort = () => resolve(abortedResult(signal, performance.now() - started));
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });

    return Promise.race([work(), aborted]);
  }

  async #legacyParent(run: RunningRun): Promise<ParentSnapshot | undefined> {
    const parent = run.parentRunId ? await this.deps.runs.get(run.parentRunId) : undefined;

    return parent && parentSnapshotOf(parent);
  }

  async #finish(
    run: RunningRun,
    result: TargetResult,
    job: Job | undefined,
    policy: JobPolicy | undefined,
  ): Promise<void> {
    const retry = policy?.retry ?? noRetry;
    const next = finishAttempt(run, { result, retry, now: this.deps.clock.now() });
    await this.#commit(run, next, job);
  }

  async #commit(
    previous: RunningRun,
    next: PendingRun | FinishedRun | SkippedRun,
    job: Job | undefined,
  ): Promise<void> {
    const saved = await this.#completion.commit(previous, next, job);
    if (saved.isErr()) {
      this.deps.logger.warn('Run changed concurrently; dropping update', { runId: previous.id });
    }
  }
}
