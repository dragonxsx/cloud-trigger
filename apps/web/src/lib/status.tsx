import { RUN_STATUS_STYLE } from '@cloud-trigger/core';
import { Badge, Loader, Tooltip } from '@mantine/core';
import {
  IconAlertTriangle,
  IconBan,
  IconCircleCheck,
  IconCircleX,
  IconClockExclamation,
  IconClockPause,
  IconPlayerSkipForward,
} from '@tabler/icons-react';
import type { ReactNode } from 'react';

import type { RunStatusDto } from './api';

interface StatusStyle {
  readonly label: string;
  readonly color: string;
  readonly icon: ReactNode;
}

const size = 14;

const ICONS: Record<RunStatusDto, ReactNode> = {
  succeeded: <IconCircleCheck size={size} />,
  failed: <IconCircleX size={size} />,
  timed_out: <IconAlertTriangle size={size} />,
  cancelled: <IconBan size={size} />,
  skipped: <IconPlayerSkipForward size={size} />,
  pending: <IconClockPause size={size} />,
  running: <Loader size={10} color="signal" />,
};

const styleFor = (status: RunStatusDto): StatusStyle => ({
  ...RUN_STATUS_STYLE[status],
  icon: ICONS[status],
});

export const STATUS: Record<RunStatusDto, StatusStyle> = {
  succeeded: styleFor('succeeded'),
  failed: styleFor('failed'),
  timed_out: styleFor('timed_out'),
  cancelled: styleFor('cancelled'),
  skipped: styleFor('skipped'),
  pending: styleFor('pending'),
  running: styleFor('running'),
};

export const CHART_STACK_ORDER = [
  'failed',
  'timed_out',
  'succeeded',
  'cancelled',
  'skipped',
] as const satisfies readonly RunStatusDto[];

export function StatusBadge({ status }: { status: RunStatusDto }) {
  const s = STATUS[status];

  return (
    <Badge
      variant="light"
      radius="sm"
      leftSection={<span style={{ display: 'inline-flex', color: s.color }}>{s.icon}</span>}
      styles={{
        root: {
          color: 'var(--ct-ink)',
          background: `color-mix(in srgb, ${s.color} 16%, transparent)`,
          textTransform: 'none',
          fontWeight: 600,
        },
      }}
    >
      {s.label}
    </Badge>
  );
}

export function LateBadge({ reasons }: { reasons: readonly string[] }) {
  return (
    <Tooltip label={reasons.join('; ') || 'Breached its SLA'} withArrow multiline width={260}>
      <Badge
        variant="outline"
        color="gray"
        radius="sm"
        leftSection={<IconClockExclamation size={12} style={{ display: 'block' }} />}
        styles={{ root: { textTransform: 'none', fontWeight: 600, color: 'var(--ct-ink)' } }}
      >
        Late
      </Badge>
    </Tooltip>
  );
}
