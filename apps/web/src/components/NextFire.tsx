import { Text, Tooltip } from '@mantine/core';
import { useEffect, useState } from 'react';

import { dateTime, fromNow } from '../lib/format';
import { HintBadge } from '../lib/status';

const CLOCK_TICK_MS = 30_000;
const DUE_NOW_MS = 60_000;

export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);

    return () => window.clearInterval(timer);
  }, []);

  return now;
}

export function NextFire({
  at,
  now,
  dimmed = false,
}: {
  at: string;
  now: number;
  dimmed?: boolean;
}) {
  const lag = now - Date.parse(at);
  if (lag > DUE_NOW_MS) {
    return (
      <HintBadge
        label="Overdue"
        color="orange"
        hint={`Was due ${dateTime(at)} (${fromNow(at)}). Check that a worker is running.`}
      />
    );
  }

  return (
    <Tooltip label={dateTime(at)} withArrow openDelay={300}>
      <Text size="sm" component="span" {...(dimmed && { color: 'dimmed' })}>
        {lag >= 0 ? 'Due now' : fromNow(at)}
        <span className="ct-sr-only">, {dateTime(at)}</span>
      </Text>
    </Tooltip>
  );
}
