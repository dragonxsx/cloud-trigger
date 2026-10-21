import { Badge, Tooltip } from '@mantine/core';

import { fromNow } from '../lib/format';
import { type LiveState, useLiveStatus } from '../providers/live-provider';

const LABELS: Record<LiveState, { label: string; color: string; hint: string }> = {
  live: { label: 'Live', color: 'teal', hint: 'Runs update on this page as they happen.' },
  connecting: { label: 'Connecting', color: 'gray', hint: 'Connecting to live run updates…' },
  reconnecting: {
    label: 'Reconnecting',
    color: 'orange',
    hint: 'Live updates dropped. Retrying every few seconds; reload the page if this persists.',
  },
  paused: {
    label: 'Paused',
    color: 'gray',
    hint: 'Live updates are paused while no page needs them or the tab is hidden.',
  },
};

const TOOLTIP_EVENTS = { hover: true, focus: true, touch: true };

export function LiveIndicator() {
  const status = useLiveStatus();
  if (status.state === 'paused' && status.lastEventAt === null) {
    return null;
  }
  const style = LABELS[status.state];
  const last =
    status.lastEventAt === null
      ? 'No run events yet.'
      : `Last run event ${fromNow(new Date(status.lastEventAt).toISOString())}.`;

  return (
    <Tooltip
      label={`${style.hint} ${last}`}
      multiline
      width={260}
      withArrow
      events={TOOLTIP_EVENTS}
    >
      <Badge
        component="span"
        tabIndex={0}
        variant="dot"
        color={style.color}
        size="md"
        aria-label={`Live updates: ${style.label}`}
        styles={{ root: { textTransform: 'none', fontWeight: 600, cursor: 'help' } }}
      >
        {style.label}
      </Badge>
    </Tooltip>
  );
}
