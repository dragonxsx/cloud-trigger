import { useSubscription } from '@refinedev/core';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

export function useLiveAnalyticsRefresh(intervalMs: number): void {
  const queryClient = useQueryClient();
  const last = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useSubscription({
    channel: 'resources/runs',
    types: ['*'],
    onLiveEvent: () => {
      if (timer.current !== undefined) {
        return;
      }
      const wait = Math.max(0, last.current + intervalMs - Date.now());
      timer.current = window.setTimeout(() => {
        timer.current = undefined;
        last.current = Date.now();
        void queryClient.invalidateQueries({ queryKey: ['analytics'] });
      }, wait);
    },
  });
}
