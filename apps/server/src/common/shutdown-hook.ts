import type { OnApplicationShutdown } from '@nestjs/common';

export class ShutdownHook implements OnApplicationShutdown {
  constructor(private readonly release: () => Promise<void>) {}

  onApplicationShutdown(): Promise<void> {
    return this.release();
  }
}
