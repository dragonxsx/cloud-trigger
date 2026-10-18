import type { Persistence, Run } from '@cloud-trigger/core';
import { EventPublisher } from '@orpc/server';

import { token } from '../../common/tokens.js';

export type RunEvents = EventPublisher<{ run: Run }>;

export const RUN_EVENTS = token<RunEvents>('RUN_EVENTS');

export function publishRunChanges(persistence: Persistence): RunEvents {
  const runEvents = new EventPublisher<{ run: Run }>();
  persistence.events.subscribe((event) => {
    if (event.type === 'run.changed') {
      runEvents.publish('run', event.run);
    }
  });
  persistence.events.start();

  return runEvents;
}
