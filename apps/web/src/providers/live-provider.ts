import type { LiveEvent, LiveProvider } from '@refinedev/core';

import { client } from '../lib/api';

type Callback = (event: LiveEvent) => void;

const RECONNECT_FOREVER = { retry: Number.POSITIVE_INFINITY, retryDelay: 3_000 };

export function createSharedRunStreamLiveProvider(): LiveProvider {
  const subscribers = new Map<symbol, { channel: string; callback: Callback }>();
  let controller: AbortController | undefined;

  const emit = (channel: string, id: string) => {
    for (const s of subscribers.values()) {
      if (s.channel === channel) {
        s.callback({ channel, type: 'updated', payload: { ids: [id] }, date: new Date() });
      }
    }
  };

  const refreshRunAndItsJob = async (signal: AbortSignal) => {
    const runs = await client.runs.stream({}, { signal, context: RECONNECT_FOREVER });
    for await (const run of runs) {
      emit('resources/runs', run.id);
      emit('resources/jobs', run.jobId);
    }
  };

  return {
    subscribe: ({ channel, callback }) => {
      const key = Symbol(channel);
      subscribers.set(key, { channel, callback });
      if (!controller) {
        controller = new AbortController();
        void refreshRunAndItsJob(controller.signal).catch(() => undefined);
      }

      return key;
    },
    unsubscribe: (key: unknown) => {
      if (typeof key === 'symbol') {
        subscribers.delete(key);
      }
      if (subscribers.size === 0) {
        controller?.abort();
        controller = undefined;
      }
    },
  };
}
