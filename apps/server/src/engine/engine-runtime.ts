import type { Logger } from '@cloud-trigger/core';
import type { Reaper, Scheduler, Worker } from '@cloud-trigger/engine';

export class EngineRuntime {
  constructor(
    private readonly parts: { scheduler?: Scheduler; reaper?: Reaper; worker?: Worker },
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.parts.scheduler?.start();
    this.parts.reaper?.start();
    this.parts.worker?.start();
    this.logger.info('Engine started', {
      scheduler: !!this.parts.scheduler,
      worker: !!this.parts.worker,
    });
  }

  async stop(): Promise<void> {
    await Promise.all([this.parts.scheduler?.stop(), this.parts.reaper?.stop()]);
    await this.parts.worker?.stop();
    this.logger.info('Engine stopped');
  }
}
