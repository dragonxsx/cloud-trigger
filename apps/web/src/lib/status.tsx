import { Badge, Loader } from '@mantine/core';
import {
  IconAlertTriangle,
  IconBan,
  IconCircleCheck,
  IconCircleX,
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

export const STATUS: Record<RunStatusDto, StatusStyle> = {
  succeeded: { label: 'Succeeded', color: '#0ca30c', icon: <IconCircleCheck size={size} /> },
  failed: { label: 'Failed', color: '#d03b3b', icon: <IconCircleX size={size} /> },
  timed_out: { label: 'Timed out', color: '#e09a0e', icon: <IconAlertTriangle size={size} /> },
  cancelled: { label: 'Cancelled', color: '#8a93a3', icon: <IconBan size={size} /> },
  skipped: { label: 'Skipped', color: '#b3bac6', icon: <IconPlayerSkipForward size={size} /> },
  pending: { label: 'Pending', color: '#557de7', icon: <IconClockPause size={size} /> },
  running: { label: 'Running', color: '#2a5bd7', icon: <Loader size={10} color="signal" /> },
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
