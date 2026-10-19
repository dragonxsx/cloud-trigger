import type { Logger } from '@cloud-trigger/core';
import type { OnApplicationBootstrap } from '@nestjs/common';

import type { SetupToken } from '../../auth/setup-token.js';
import type { SetupBackend } from './setup.router.js';

export class SetupAnnouncer implements OnApplicationBootstrap {
  constructor(
    private readonly backend: SetupBackend,
    private readonly token: SetupToken,
    private readonly logger: Logger,
    private readonly publicUrl: string | undefined,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const stage = await this.backend.stage();
    if (stage === 'done') {
      return;
    }
    const url = `${this.publicUrl?.replace(/\/$/, '') ?? ''}/setup`;
    this.logger.warn(
      this.token.generated
        ? `Setup required: open ${url} and enter the setup token ${this.token.value}`
        : `Setup required: open ${url} and enter the SETUP_TOKEN value`,
      { stage },
    );
  }
}
