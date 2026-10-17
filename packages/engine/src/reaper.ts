import {
  type Clock,
  type JobRepository,
  type Logger,
  type RunQueue,
  type RunRepository,
  expireLease,
  noRetry,
} from '@cloud-trigger/core';

import type { RunLifecycleListener } from './lifecycle.js';
import { PollingLoop } from './loop.js';
import { RunCompletion } from './run-completion.js';

export interface ReaperDeps {
  readonly jobs: JobRepository;
  readonly runs: RunRepository;
  readonly queue: RunQueue;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly listeners: readonly RunLifecycleListener[];
}

export class Reaper {
  readonly #loop: PollingLoop;
  readonly #completion: RunCompletion;

  constructor(
    private readonly deps: ReaperDeps,
    options: { intervalMs: number; batchSize: number },
  ) {
    this.#loop = new PollingLoop(
      'reaper',
      options.intervalMs,
      () => this.tick(options.batchSize),
      deps.logger,
    );
    this.#completion = new RunCompletion(deps);
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
      const retry = job?.policy.retry ?? noRetry;
      const result = await this.#completion.commit(run, expireLease(run, { retry, now }), job);
      if (result.isOk()) {
        this.deps.logger.warn('Recovered run with expired lease', {
          runId: run.id,
          workerId: run.lease.workerId,
          status: result.value.status,
        });
      }
    }

    return expired.length === batchSize;
  }
}
