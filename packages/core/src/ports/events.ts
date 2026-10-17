import type { JobId } from '../domain/ids.js';
import type { Run } from '../domain/run.js';

export interface RunChangedEvent {
  readonly type: 'run.changed';
  readonly run: Run;
}

export interface JobChangedEvent {
  readonly type: 'job.changed';
  readonly jobId: JobId;
  readonly change: 'created' | 'updated' | 'deleted' | 'paused' | 'resumed';
}

export type DomainEvent = RunChangedEvent | JobChangedEvent;
export type Unsubscribe = () => void;

export interface EventBus {
  publish(event: DomainEvent): Promise<void>;
  subscribe(handler: (event: DomainEvent) => void): Unsubscribe;
}
