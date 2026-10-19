const FREE_ATTEMPTS = 3;
const MAX_BLOCK_MS = 15 * 60_000;
const MAX_TRACKED = 10_000;

interface Failures {
  readonly count: number;
  readonly blockedUntil: number;
}

export class LoginThrottle {
  readonly #failures = new Map<string, Failures>();

  retryAfterMs(username: string, now: Date): number {
    const entry = this.#failures.get(username.toLowerCase());

    return entry ? Math.max(0, entry.blockedUntil - now.getTime()) : 0;
  }

  recordFailure(username: string, now: Date): void {
    const key = username.toLowerCase();
    const count = (this.#failures.get(key)?.count ?? 0) + 1;
    const blockMs =
      count < FREE_ATTEMPTS ? 0 : Math.min(MAX_BLOCK_MS, 1_000 * 2 ** (count - FREE_ATTEMPTS));
    if (this.#failures.size >= MAX_TRACKED && !this.#failures.has(key)) {
      const oldest = this.#failures.keys().next();
      if (!oldest.done) {
        this.#failures.delete(oldest.value);
      }
    }
    this.#failures.set(key, { count, blockedUntil: now.getTime() + blockMs });
  }

  recordSuccess(username: string): void {
    this.#failures.delete(username.toLowerCase());
  }
}
