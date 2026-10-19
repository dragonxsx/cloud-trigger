import type { DomainEvent, JobChangedEvent, Unsubscribe } from '../ports/events.js';

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

const LOCAL_ONLY_JOB_CHANGES: ReadonlySet<JobChangedEvent['change']> = new Set([
  'paused',
  'resumed',
]);

export const isLocalOnlyEvent = (event: DomainEvent): boolean =>
  event.type === 'job.changed' && LOCAL_ONLY_JOB_CHANGES.has(event.change);
