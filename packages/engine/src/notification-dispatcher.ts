import {
  type Clock,
  type Logger,
  type NotificationDelivery,
  type NotificationOutbox,
  type NotifyResult,
  type ProviderRegistry,
  type RetryPolicy,
  type SecretResolver,
  ResultAsync,
  computeRetryDelay,
  err,
  toError,
} from '@cloud-trigger/core';

import { PollingLoop } from './loop.js';

export interface NotificationDispatcherOptions {
  readonly workerId: string;
  readonly pollIntervalMs: number;
  readonly timeoutMs: number;
  readonly leaseMs: number;
  readonly retry: RetryPolicy;
}

export interface NotificationDispatcherDeps {
  readonly outbox: NotificationOutbox;
  readonly registry: ProviderRegistry;
  readonly secrets: SecretResolver;
  readonly clock: Clock;
  readonly logger: Logger;
}

export class NotificationDispatcher {
  readonly #loop: PollingLoop;

  constructor(
    private readonly deps: NotificationDispatcherDeps,
    private readonly options: NotificationDispatcherOptions,
  ) {
    this.#loop = new PollingLoop(
      'notification-dispatcher',
      options.pollIntervalMs,
      () => this.tick(),
      deps.logger,
    );
  }

  start(): void {
    this.#loop.start();
  }

  stop(): Promise<void> {
    return this.#loop.stop();
  }

  async tick(): Promise<boolean> {
    const claimed = await this.deps.outbox.claimNext({
      workerId: this.options.workerId,
      now: this.deps.clock.now(),
      leaseMs: this.options.leaseMs,
    });
    if (!claimed) {
      return false;
    }
    await this.deliver(claimed);

    return true;
  }

  async deliver(claimed: NotificationDelivery): Promise<void> {
    const outcome = await this.#send(claimed);
    const now = this.deps.clock.now();
    if (outcome.isOk()) {
      if (!(await this.deps.outbox.complete(claimed, now))) {
        this.deps.logger.warn('Notification lease lost after delivery', { key: claimed.key });
      }

      return;
    }
    const exhausted = claimed.attempts >= this.options.retry.maxAttempts;
    const retryAt =
      outcome.error.retryable && !exhausted
        ? new Date(now.getTime() + computeRetryDelay(this.options.retry, claimed.attempts))
        : null;
    this.deps.logger.warn('Notification delivery failed', {
      key: claimed.key,
      attempt: claimed.attempts,
      error: outcome.error.message,
      retryAt: retryAt?.toISOString(),
    });
    await this.deps.outbox.fail(claimed, { error: outcome.error.message, retryAt, now });
  }

  async #send(claimed: NotificationDelivery): Promise<NotifyResult> {
    const bound = this.deps.registry
      .get('notifier', claimed.notifier.type)
      .andThen((provider) => provider.bind(claimed.notifier.config));
    if (bound.isErr()) {
      return err({ message: bound.error.message, retryable: false });
    }
    const sent = await ResultAsync.fromPromise(
      bound.value.notify(claimed.payload, {
        secrets: this.deps.secrets,
        signal: AbortSignal.timeout(this.options.timeoutMs),
        now: this.deps.clock.now(),
      }),
      toError,
    );

    return sent.isOk() ? sent.value : err({ message: sent.error.message, retryable: true });
  }
}
