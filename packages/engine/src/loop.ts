import { setTimeout as sleep } from 'node:timers/promises';

import type { Logger } from '@cloud-trigger/core';

export class PollingLoop {
  #controller: AbortController | undefined;
  #done: Promise<void> | undefined;

  constructor(
    private readonly name: string,
    private readonly idleIntervalMs: number,
    private readonly tickReportingMoreWork: () => Promise<boolean>,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.#controller) {
      return;
    }
    const controller = new AbortController();
    this.#controller = controller;
    this.#done = this.#run(controller.signal);
  }

  async stop(): Promise<void> {
    this.#controller?.abort();
    await this.#done;
    this.#controller = undefined;
  }

  async #run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const hasMoreWork = await this.tickReportingMoreWork().catch((error: unknown) => {
        this.logger.error(`${this.name} tick failed`, { err: error });

        return false;
      });
      if (!hasMoreWork) {
        await sleep(this.idleIntervalMs, undefined, { signal }).catch(() => undefined);
      }
    }
  }
}
