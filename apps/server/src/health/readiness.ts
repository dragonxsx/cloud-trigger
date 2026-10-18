import type { Persistence } from '@cloud-trigger/core';

import type { Role } from '../config/config.js';

export class Readiness {
  constructor(
    private readonly persistence: Persistence,
    readonly roles: readonly Role[],
  ) {}

  database(): Promise<boolean> {
    return this.persistence.ping();
  }
}
