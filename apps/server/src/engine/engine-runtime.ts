import type { Logger } from '@cloud-trigger/core';
import type { Worker } from '@cloud-trigger/engine';

export interface BackgroundLoop {
  start(): void;
  stop(): Promise<void>;
}

export class EngineRuntime {
  constructor(
    private readonly parts: { loops: readonly BackgroundLoop[]; worker?: Worker | undefined },
    private readonly logger: Logger,
  ) {}

  start(): void {
    for (const loop of this.parts.loops) {
      loop.start();
    }
    this.parts.worker?.start();
    this.logger.info('Engine started', {
      loops: this.parts.loops.length,
      worker: !!this.parts.worker,
    });
  }

  async stop(): Promise<void> {
    await Promise.all(this.parts.loops.map((loop) => loop.stop()));
    await this.parts.worker?.stop();
    this.logger.info('Engine stopped');
  }
}
