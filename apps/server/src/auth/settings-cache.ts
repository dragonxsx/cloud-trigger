import type { AuthSettings, AuthSettingsStore, Clock } from '@cloud-trigger/core';

const TTL_MS = 5_000;

export class AuthSettingsCache {
  #cached: { readonly settings: AuthSettings | undefined; readonly loadedAt: number } | undefined;
  #loading: Promise<AuthSettings | undefined> | undefined;

  constructor(
    private readonly store: AuthSettingsStore,
    private readonly clock: Clock,
  ) {}

  get(): Promise<AuthSettings | undefined> {
    const cached = this.#cached;
    if (cached && this.clock.now().getTime() - cached.loadedAt < TTL_MS) {
      return Promise.resolve(cached.settings);
    }
    this.#loading ??= this.store
      .get()
      .then((settings) => {
        this.set(settings);

        return settings;
      })
      .finally(() => {
        this.#loading = undefined;
      });

    return this.#loading;
  }

  set(settings: AuthSettings | undefined): void {
    this.#cached = { settings, loadedAt: this.clock.now().getTime() };
  }
}
