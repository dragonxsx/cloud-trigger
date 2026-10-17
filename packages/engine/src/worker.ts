import {
  assertNever,
  type BoundInput,
  type BoundTarget,
  type Clock,
  EngineErrorCode,
  type FinishedRun,
  type Job,
  type JobRepository,
  type Logger,
  type PendingRun,
  type ProviderRegistry,
  type Run,
  type RunContext,
  type RunQueue,
  type RunRepository,
  type RunningRun,
  type SecretResolver,
  type SkippedRun,
  type TargetResult,
  ResultAsync,
  abortedResult,
  currentAttempt,
  failedResult,
  finishAttempt,
  noRetry,
  requeueClaimedRun,
  skipClaimedRun,
  toError,
} from '@cloud-trigger/core';

import { bindJob } from './config-validation.js';
import type { RunLifecycleListener } from './lifecycle.js';
import { PollingLoop } from './loop.js';
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
  | { action: 'buffer' };

export class Worker {
  readonly #loop: PollingLoop;
  readonly #inFlight = new Set<Promise<void>>();
  readonly #completion: RunCompletion;

  constructor(
    private readonly deps: WorkerDeps,
    private readonly options: WorkerOptions,
  ) {
    this.#loop = new PollingLoop('worker', options.pollIntervalMs, () => this.tick(), deps.logger);
    this.#completion = new RunCompletion(deps);
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

  async process(claimed: RunningRun): Promise<void> {
    const job = await this.deps.jobs.get(claimed.jobId);
    if (!job) {
      await this.#finish(
        claimed,
        failedResult('job_deleted', 'Job no longer exists', false),
        undefined,
      );

      return;
    }

    const decision = await this.#overlapDecision(job, claimed);
    switch (decision.action) {
      case 'skip':
        await this.#commit(
          claimed,
          skipClaimedRun(claimed, { reason: decision.reason, now: this.deps.clock.now() }),
          job,
        );

        return;
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
          await this.#commit(
            claimed,
            skipClaimedRun(claimed, {
              reason: 'overlap: buffer_one (buffer already full)',
              now: this.deps.clock.now(),
            }),
            job,
          );
        } else {
          this.deps.logger.warn('Run changed concurrently; dropping update', { runId: claimed.id });
        }

        return;
      }
      case 'run':
        break;
    }

    const bound = bindJob(this.deps.registry, job);
    if (bound.isErr()) {
      const message = bound.error.issues.map((i) => `${i.path}: ${i.message}`).join('; ');
      await this.#finish(claimed, failedResult(EngineErrorCode.configInvalid, message, false), job);

      return;
    }
    await this.#execute(claimed, job, bound.value.input, bound.value.target);
  }

  async #overlapDecision(job: Job, run: RunningRun): Promise<OverlapDecision> {
    const policy = job.policy.overlap;
    switch (policy) {
      case 'allow':
        return { action: 'run' };
      // Exclusion via the store's execution slot; claim timestamps disagree across replicas.
      case 'forbid':
        return (await this.deps.queue.acquireExecution(run))
          ? { action: 'run' }
          : { action: 'skip', reason: 'overlap: forbid (previous run still active)' };
      case 'buffer_one':
        return (await this.deps.queue.acquireExecution(run))
          ? { action: 'run' }
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
    input: BoundInput,
    target: BoundTarget,
  ): Promise<void> {
    let current = claimed;
    let leaseLost = false;
    const cancel = new AbortController();
    const signal = AbortSignal.any([AbortSignal.timeout(job.policy.timeoutMs), cancel.signal]);

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

    const ctx: RunContext = {
      runId: claimed.id,
      jobId: job.id,
      jobName: job.name,
      attempt: currentAttempt(claimed),
      scheduledAt: claimed.scheduledAt,
      reason: claimed.reason,
      secrets: this.deps.secrets,
      now: this.deps.clock.now(),
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

    if (leaseLost) {
      this.deps.logger.warn('Discarding result: lease lost (run was reclaimed)', {
        runId: claimed.id,
      });

      return;
    }
    await this.#finish(current, result, job);
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

  async #finish(run: RunningRun, result: TargetResult, job: Job | undefined): Promise<void> {
    const retry = job?.policy.retry ?? noRetry;
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
