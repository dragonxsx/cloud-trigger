import type { LiveEvent, LiveProvider } from '@refinedev/core';
import { useSyncExternalStore } from 'react';
import { z } from 'zod';

import { client } from '../lib/api';

type Callback = (event: LiveEvent) => void;

export type LiveState = 'connecting' | 'live' | 'reconnecting' | 'paused';

export interface LiveStatus {
  readonly state: LiveState;
  readonly lastEventAt: number | null;
}

const LOCK_NAME = 'cloud-trigger.run-stream';
const CHANNEL_NAME = 'cloud-trigger.run-stream';
const FLUSH_MS = 2_500;
const RETRY_DELAY_MS = 3_000;
const QUIET_START_MS = 5_000;
const RESIGN_DELAY_MS = 2_000;
const CHANNELS = ['resources/runs', 'resources/jobs'] as const;

const Message = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello') }),
  z.object({ type: z.literal('run'), runId: z.string(), jobId: z.string() }),
  z.object({
    type: z.literal('status'),
    state: z.enum(['connecting', 'live', 'reconnecting', 'paused']),
    lastEventAt: z.number().nullable(),
  }),
]);
type Message = z.output<typeof Message>;

let status: LiveStatus = { state: 'paused', lastEventAt: null };
const statusListeners = new Set<() => void>();

const setStatus = (next: LiveStatus): void => {
  if (next.state === status.state && next.lastEventAt === status.lastEventAt) {
    return;
  }
  status = next;
  for (const listener of statusListeners) {
    listener();
  }
};

const subscribeStatus = (listener: () => void): (() => void) => {
  statusListeners.add(listener);

  return () => {
    statusListeners.delete(listener);
  };
};

export const useLiveStatus = (): LiveStatus => useSyncExternalStore(subscribeStatus, () => status);

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

const openChannel = (): BroadcastChannel | undefined =>
  typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(CHANNEL_NAME);

const lockManager = (): LockManager | undefined =>
  typeof navigator !== 'undefined' && 'locks' in navigator ? navigator.locks : undefined;

export function createSharedRunStreamLiveProvider(): LiveProvider {
  const subscribers = new Map<symbol, { channel: string; callback: Callback }>();
  const pending = new Map<string, Set<string>>();
  const broadcast = openChannel();
  let flushTimer: number | undefined;
  let leadership: AbortController | undefined;
  let firstSubscribeAt: number | undefined;
  let leading = false;
  let resignTimer: number | undefined;

  const flush = () => {
    flushTimer = undefined;
    const batches = [...pending.entries()];
    pending.clear();
    for (const [channel, ids] of batches) {
      for (const s of subscribers.values()) {
        if (s.channel === channel) {
          s.callback({ channel, type: 'updated', payload: { ids: [...ids] }, date: new Date() });
        }
      }
    }
  };

  const queue = (channel: string, id: string) => {
    const ids = pending.get(channel) ?? new Set<string>();
    if (id !== '') {
      ids.add(id);
    }
    pending.set(channel, ids);
    flushTimer ??= window.setTimeout(flush, FLUSH_MS);
  };

  const handleRun = (runId: string, jobId: string) => {
    queue('resources/runs', runId);
    queue('resources/jobs', jobId);
  };

  const post = broadcast?.postMessage.bind(broadcast);
  const send = (message: Message) => {
    post?.(message);
  };

  const receive = (message: Message) => {
    if (message.type === 'run') {
      setStatus({ state: 'live', lastEventAt: Date.now() });
      handleRun(message.runId, message.jobId);
    } else if (message.type === 'status') {
      setStatus({ state: message.state, lastEventAt: message.lastEventAt });
    }
  };

  const publish = (message: Message) => {
    receive(message);
    send(message);
  };

  broadcast?.addEventListener('message', (event: MessageEvent<unknown>) => {
    const parsed = Message.safeParse(event.data);
    if (!parsed.success) {
      return;
    }
    if (parsed.data.type === 'hello') {
      if (leading) {
        send({ type: 'status', state: status.state, lastEventAt: status.lastEventAt });
      }

      return;
    }
    receive(parsed.data);
  });

  const announce = (state: LiveState) => {
    publish({ type: 'status', state, lastEventAt: status.lastEventAt });
  };

  const stream = async (signal: AbortSignal) => {
    announce('connecting');
    const quietStart =
      firstSubscribeAt !== undefined && performance.now() - firstSubscribeAt < QUIET_START_MS;
    if (!quietStart) {
      for (const channel of CHANNELS) {
        queue(channel, '');
      }
    }
    while (!signal.aborted) {
      try {
        const runs = await client.runs.stream(
          {},
          {
            signal,
            context: {
              retry: Number.POSITIVE_INFINITY,
              retryDelay: RETRY_DELAY_MS,
              onRetry: () => {
                announce('reconnecting');

                return (ok: boolean) => {
                  if (ok) {
                    announce('live');
                  }
                };
              },
            },
          },
        );
        announce('live');
        for await (const run of runs) {
          publish({ type: 'run', runId: run.id, jobId: run.jobId });
        }
      } catch {
        if (signal.aborted) {
          break;
        }
        announce('reconnecting');
        await sleep(RETRY_DELAY_MS, signal);
      }
    }
  };

  const lead = () => {
    if (leadership) {
      return;
    }
    const controller = new AbortController();
    leadership = controller;
    const locks = lockManager();
    const run = async () => {
      leading = true;
      try {
        await stream(controller.signal);
      } finally {
        leading = false;
        announce('paused');
      }
    };
    const held = locks ? locks.request(LOCK_NAME, { signal: controller.signal }, run) : run();
    void held.catch(() => undefined);
  };

  const resign = () => {
    resignTimer = undefined;
    leadership?.abort();
    leadership = undefined;
  };

  const wantsStream = () =>
    subscribers.size > 0 &&
    (typeof document === 'undefined' || document.visibilityState === 'visible');

  const reconcile = () => {
    if (wantsStream()) {
      window.clearTimeout(resignTimer);
      resignTimer = undefined;
      lead();
    } else if (leadership) {
      resignTimer ??= window.setTimeout(resign, RESIGN_DELAY_MS);
    }
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', reconcile);
  }
  send({ type: 'hello' });

  return {
    subscribe: ({ channel, callback }) => {
      const key = Symbol(channel);
      subscribers.set(key, { channel, callback });
      firstSubscribeAt ??= performance.now();
      reconcile();

      return key;
    },
    unsubscribe: (key: unknown) => {
      if (typeof key === 'symbol') {
        subscribers.delete(key);
      }
      reconcile();
    },
  };
}
