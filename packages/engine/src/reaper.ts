import {
  type Clock,
  type GroupRepository,
  type JobRepository,
  type Logger,
  type RateLimiter,
  type RunQueue,
  type RunRepository,
  expireLease,
  noRetry,
} from '@cloud-trigger/core';

import type { RunLifecycleListener } from './lifecycle.js';
import { PollingLoop } from './loop.js';
import { PolicyResolver } from './policies.js';
import { RunCompletion } from './run-completion.js';

export interface ReaperDeps {
  readonly jobs: JobRepository;
  readonly runs: RunRepository;
  readonly queue: RunQueue;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly listeners: readonly RunLifecycleListener[];
  readonly groups?: GroupRepository | undefined;
  readonly rateLimiter?: RateLimiter | undefined;
}

export interface ReaperOptions {
  readonly intervalMs: number;
  readonly batchSize: number;
  readonly slotIdleMs?: number | undefined;
}

export class Reaper {
  readonly #loop: PollingLoop;
  readonly #completion: RunCompletion;
  readonly #policies: PolicyResolver;

  constructor(
    private readonly deps: ReaperDeps,
    private readonly options: ReaperOptions,
  ) {
    this.#loop = new PollingLoop(
      'reaper',
      options.intervalMs,
      () => this.tick(options.batchSize),
      deps.logger,
    );
    this.#completion = new RunCompletion(deps);
    this.#policies = new PolicyResolver(deps.groups, deps.clock);
  }

  start(): void {
    this.#loop.start();
  }

  stop(): Promise<void> {
    return this.#loop.stop();
  }

  async tick(batchSize = 100): Promise<boolean> {
    const now = this.deps.clock.now();
    const expired = await this.deps.queue.findExpired({ now, limit: batchSize });
    for (const run of expired) {
      const job = await this.deps.jobs.get(run.jobId);
      const retry = job ? (await this.#policies.resolve(job)).policy.retry : noRetry;
      const result = await this.#completion.commit(run, expireLease(run, { retry, now }), job);
      if (result.isOk()) {
        this.deps.logger.warn('Recovered run with expired lease', {
          runId: run.id,
          workerId: run.lease.workerId,
          status: result.value.status,
        });
      }
    }

    await this.#reconcileSlots(now);

    return expired.length === batchSize;
  }

  async #reconcileSlots(now: Date): Promise<void> {
    const limiter = this.deps.rateLimiter;
    if (!limiter) {
      return;
    }
    const idleSince = new Date(now.getTime() - (this.options.slotIdleMs ?? 60_000));
    for (const held of await limiter.listHeld()) {
      const running = await this.deps.runs.countHoldingSlot(held.key);
      if (running < held.running && (await limiter.reconcile(held.key, { running, idleSince }))) {
        this.deps.logger.warn('Released leaked rate-limit slots', {
          key: held.key,
          from: held.running,
          to: running,
        });
      }
    }
  }
}
