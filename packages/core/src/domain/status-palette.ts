import type { RunStatus } from './run.js';

export const RUN_STATUS_STYLE: Readonly<Record<RunStatus, { label: string; color: string }>> = {
  succeeded: { label: 'Succeeded', color: '#0ca30c' },
  failed: { label: 'Failed', color: '#d03b3b' },
  timed_out: { label: 'Timed out', color: '#e09a0e' },
  cancelled: { label: 'Cancelled', color: '#8a93a3' },
  skipped: { label: 'Skipped', color: '#b3bac6' },
  pending: { label: 'Pending', color: '#557de7' },
  running: { label: 'Running', color: '#2a5bd7' },
};
