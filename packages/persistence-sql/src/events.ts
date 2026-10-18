import {
  type DomainEvent,
  type EventBus,
  JobId,
  type JobChangedEvent,
  type Unsubscribe,
} from '@cloud-trigger/core';

export interface ChangeSink {
  runChanged(id: string): void;
  jobChanged(change: JobChangedEvent['change'], id: string): void;
}

export interface ClosableEventBus extends EventBus {
  readonly start: () => void;
  readonly close: () => Promise<void>;
}

export class LocalEventHub {
  readonly #handlers = new Set<(event: DomainEvent) => void>();

  emit(event: DomainEvent): void {
    for (const handler of this.#handlers) {
      handler(event);
    }
  }

  subscribe(handler: (event: DomainEvent) => void): Unsubscribe {
    this.#handlers.add(handler);

    return () => {
      this.#handlers.delete(handler);
    };
  }
}

export class InProcessEventBus implements ClosableEventBus, ChangeSink {
  readonly #hub = new LocalEventHub();
  #started = false;

  constructor(
    private readonly loadRun: (id: string) => Promise<DomainEvent | undefined>,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  readonly start = (): void => {
    this.#started = true;
  };

  readonly close = (): Promise<void> => {
    this.#started = false;

    return Promise.resolve();
  };

  publish(event: DomainEvent): Promise<void> {
    this.#hub.emit(event);

    return Promise.resolve();
  }

  subscribe(handler: (event: DomainEvent) => void): Unsubscribe {
    return this.#hub.subscribe(handler);
  }

  runChanged(id: string): void {
    if (!this.#started) {
      return;
    }
    void this.#forward(id);
  }

  async #forward(id: string): Promise<void> {
    try {
      const event = await this.loadRun(id);
      if (event) {
        this.#hub.emit(event);
      }
    } catch (error: unknown) {
      this.onError(error);
    }
  }

  jobChanged(change: JobChangedEvent['change'], id: string): void {
    if (this.#started) {
      const jobId = JobId.safeParse(id);
      if (jobId.success) {
        this.#hub.emit({ type: 'job.changed', jobId: jobId.data, change });
      }
    }
  }
}
