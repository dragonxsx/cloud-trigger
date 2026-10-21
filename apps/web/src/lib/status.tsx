import { RUN_STATUS_STYLE } from '@cloud-trigger/core';
import { Badge, type BadgeProps, Loader, Tooltip } from '@mantine/core';
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

const TOOLTIP_EVENTS = { hover: true, focus: true, touch: true };

interface HintBadgeProps {
  readonly label: string;
  readonly hint: string;
  readonly color?: BadgeProps['color'];
  readonly variant?: BadgeProps['variant'];
  readonly icon?: ReactNode;
}

export function HintBadge({
  label,
  hint,
  color = 'gray',
  variant = 'light',
  icon,
}: HintBadgeProps) {
  return (
    <Tooltip label={hint} withArrow multiline width={260} events={TOOLTIP_EVENTS}>
      <Badge
        tabIndex={0}
        variant={variant}
        color={color}
        radius="sm"
        leftSection={icon}
        styles={{ root: { textTransform: 'none', fontWeight: 600, cursor: 'help' } }}
      >
        {label}
        <span className="ct-sr-only">: {hint}</span>
      </Badge>
    </Tooltip>
  );
}

export function LateBadge({ reasons }: { reasons: readonly string[] }) {
  const hint = reasons.join('; ') || 'Breached its SLA';

  return (
    <Tooltip label={hint} withArrow multiline width={260} events={TOOLTIP_EVENTS}>
      <Badge
        tabIndex={0}
        variant="outline"
        color="gray"
        radius="sm"
        leftSection={<IconClockExclamation size={12} style={{ display: 'block' }} />}
        styles={{
          root: { textTransform: 'none', fontWeight: 600, color: 'var(--ct-ink)', cursor: 'help' },
        }}
      >
        Late
        <span className="ct-sr-only">: {hint}</span>
      </Badge>
    </Tooltip>
  );
}
