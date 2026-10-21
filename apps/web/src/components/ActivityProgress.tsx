import {
  NavigationProgress,
  completeNavigationProgress,
  startNavigationProgress,
} from '@mantine/nprogress';
import { useIsFetching, useIsMutating } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

const SHOW_AFTER_MS = 300;

export function ActivityProgress() {
  const busy = useIsFetching() + useIsMutating() > 0;
  const started = useRef(false);
  useEffect(() => {
    if (!busy) {
      if (started.current) {
        started.current = false;
        completeNavigationProgress();
      }

      return undefined;
    }
    const timer = window.setTimeout(() => {
      started.current = true;
      startNavigationProgress();
    }, SHOW_AFTER_MS);

    return () => window.clearTimeout(timer);
  }, [busy]);

  return <NavigationProgress autoReset size={2} />;
}
