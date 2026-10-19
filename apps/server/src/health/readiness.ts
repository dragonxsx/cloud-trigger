import type { Role } from '../config/config.js';

export class Readiness {
  constructor(
    private readonly ping: () => Promise<boolean>,
    readonly roles: readonly Role[],
  ) {}

  database(): Promise<boolean> {
    return this.ping();
  }
}
