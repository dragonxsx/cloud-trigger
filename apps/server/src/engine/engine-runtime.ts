import type { Logger } from '@cloud-trigger/core';
import type { Worker } from '@cloud-trigger/engine';
import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';

export interface BackgroundLoop {
  start(): void;
  stop(): Promise<void>;
}

export interface EngineParts {
  readonly loops: readonly BackgroundLoop[];
  readonly worker?: Worker | undefined;
}

export class EngineRuntime implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(
    private readonly parts: EngineParts,
    private readonly logger: Logger,
  ) {}

  get loopCount(): number {
    return this.parts.loops.length;
  }

  get hasWorker(): boolean {
    return this.parts.worker !== undefined;
  }

  onApplicationBootstrap(): void {
    for (const loop of this.parts.loops) {
      loop.start();
    }
    this.parts.worker?.start();
    this.logger.info('Engine started', { loops: this.loopCount, worker: this.hasWorker });
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all(this.parts.loops.map((loop) => loop.stop()));
    await this.parts.worker?.stop();
    this.logger.info('Engine stopped');
  }
}
