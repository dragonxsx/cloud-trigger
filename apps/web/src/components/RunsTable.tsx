import {
  Anchor,
  Button,
  Checkbox,
  Group,
  ScrollArea,
  Skeleton,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconArrowUp } from '@tabler/icons-react';
import {
  type FocusEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useMemo,
  useState,
} from 'react';
import { Link, useNavigate } from 'react-router';

import type { RunDto } from '../lib/api';
import { dateTime, duration, fromNow } from '../lib/format';
import { LateBadge, STATUS, StatusBadge } from '../lib/status';

export const lastResult = (run: RunDto) =>
  run.status === 'succeeded' ||
  run.status === 'failed' ||
  run.status === 'timed_out' ||
  run.status === 'cancelled'
    ? run.result
    : run.attempts.at(-1)?.result;

export const REASON_LABEL: Record<RunDto['reason'], string> = {
  scheduled: 'Scheduled',
  manual: 'Run now',
  retry: 'Retry',
  catchup: 'Catch-up',
  backfill: 'Backfill',
  chained: 'Chained',
  replay: 'Replay',
  event: 'Event',
  workflow: 'Workflow',
};

const ERROR_TEXT: Readonly<Record<string, string>> = {
  ECONNREFUSED: 'Connection refused by host',
  ENOTFOUND: 'Host not found',
  EAI_AGAIN: 'DNS lookup failed',
  ETIMEDOUT: 'Connection timed out',
  ECONNRESET: 'Connection reset by host',
  EHOSTUNREACH: 'Host unreachable',
  ENETUNREACH: 'Network unreachable',
  EPIPE: 'Connection closed by host',
  CERT_HAS_EXPIRED: 'TLS certificate has expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'Self-signed TLS certificate',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS certificate could not be verified',
  timeout: 'Run exceeded its timeout',
  cancelled: 'Cancelled',
  lease_lost: 'Worker stopped responding',
  input_failed: 'Input from the upstream run failed',
  invalid_config: 'Invalid job configuration',
  unexpected: 'Unexpected error',
};

export const errorCodeText = (code: string): string => ERROR_TEXT[code] ?? code;

export const errorText = (
  error: { readonly code: string; readonly message: string } | undefined,
): string => {
  if (error === undefined) {
    return '';
  }

  return error.message.trim() === '' ? errorCodeText(error.code) : error.message;
};

export const runLabel = (run: Pick<RunDto, 'status' | 'jobName' | 'scheduledAt'>): string =>
  `${STATUS[run.status].label} run of ${run.jobName}, ${dateTime(run.scheduledAt)}`;

export interface RunSelection {
  readonly selected: ReadonlySet<string>;
  readonly onChange: (selected: ReadonlySet<string>) => void;
}

const SKELETON_ROWS = 6;
const INTERACTIVE = 'a, button, input, label, [role="button"]';

function SkeletonRows({ columns }: { columns: number }) {
  return (
    <>
      {Array.from({ length: SKELETON_ROWS }, (_row, row) => (
        <tr key={row}>
          {Array.from({ length: columns }, (_cell, column) => (
            <td key={column}>
              <Skeleton height={14} radius="sm" width={column === 0 ? 90 : '70%'} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export function RunsTable({
  runs,
  showJob = true,
  selection,
  loading = false,
  empty,
}: {
  runs: readonly RunDto[];
  showJob?: boolean;
  selection?: RunSelection | undefined;
  loading?: boolean;
  empty?: ReactNode;
}) {
  const navigate = useNavigate();
  const [frozen, setFrozen] = useState<readonly RunDto[] | null>(null);
  const latest = useMemo(() => new Map(runs.map((r) => [r.id, r])), [runs]);
  const shown = useMemo(
    () => (frozen ? frozen.flatMap((r) => latest.get(r.id) ?? []) : runs),
    [frozen, latest, runs],
  );
  const incoming = useMemo(() => {
    if (!frozen) {
      return 0;
    }
    const held = new Set(frozen.map((r) => r.id));

    return runs.filter((r) => !held.has(r.id)).length;
  }, [frozen, runs]);

  const hold = useCallback(() => setFrozen((current) => current ?? runs), [runs]);
  const release = useCallback(() => setFrozen(null), []);
  const onMouseLeave = (e: MouseEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(document.activeElement)) {
      release();
    }
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget;
    if (
      !(next instanceof Node && e.currentTarget.contains(next)) &&
      !e.currentTarget.matches(':hover')
    ) {
      release();
    }
  };
  const openRun = (e: MouseEvent<HTMLTableRowElement>, id: string) => {
    if (e.target instanceof Element && e.target.closest(INTERACTIVE)) {
      return;
    }
    if ((window.getSelection()?.toString() ?? '') !== '') {
      return;
    }
    const to = `/runs/show/${id}`;
    if (e.metaKey || e.ctrlKey) {
      window.open(to, '_blank', 'noopener');

      return;
    }
    void navigate(to);
  };

  const columns = 7 + (showJob ? 1 : 0) + (selection ? 1 : 0);

  if (!loading && runs.length === 0) {
    return (
      <Text color="dimmed" p="lg" align="center" component="div">
        {empty ?? 'No runs yet. Runs appear here as soon as a job fires or you use Run now.'}
      </Text>
    );
  }

  return (
    <div onMouseEnter={hold} onMouseLeave={onMouseLeave} onFocus={hold} onBlur={onBlur}>
      <div aria-live="polite">
        {incoming > 0 && (
          <Button
            variant="light"
            size="xs"
            fullWidth
            mb="xs"
            leftIcon={<IconArrowUp size={14} />}
            onClick={() => setFrozen(runs)}
          >
            {incoming === 1 ? 'Show 1 new run' : `Show ${incoming} new runs`}
          </Button>
        )}
      </div>
      <ScrollArea>
        <Table
          highlightOnHover
          verticalSpacing="xs"
          className="ct-table"
          miw={760}
          aria-busy={loading}
        >
          <thead>
            <tr>
              {selection && (
                <th style={{ width: 36 }}>
                  <Checkbox
                    aria-label="Select all runs on this page"
                    disabled={loading || shown.length === 0}
                    checked={shown.length > 0 && shown.every((r) => selection.selected.has(r.id))}
                    indeterminate={
                      shown.some((r) => selection.selected.has(r.id)) &&
                      !shown.every((r) => selection.selected.has(r.id))
                    }
                    onChange={(e) =>
                      selection.onChange(
                        new Set(e.currentTarget.checked ? shown.map((r) => r.id) : []),
                      )
                    }
                  />
                </th>
              )}
              <th>Status</th>
              {showJob && <th>Job</th>}
              <th>Scheduled</th>
              <th>Reason</th>
              <th style={{ textAlign: 'right' }}>Attempts</th>
              <th style={{ textAlign: 'right' }}>HTTP</th>
              <th style={{ textAlign: 'right' }}>Duration</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {loading && runs.length === 0 ? (
              <SkeletonRows columns={columns} />
            ) : (
              shown.map((run) => {
                const result = lastResult(run);
                const error = run.status === 'skipped' ? run.skipReason : errorText(result?.error);

                return (
                  <tr
                    key={run.id}
                    onClick={(e) => openRun(e, run.id)}
                    style={{ cursor: 'pointer' }}
                  >
                    {selection && (
                      <td>
                        <Checkbox
                          aria-label={`Select ${runLabel(run)}`}
                          checked={selection.selected.has(run.id)}
                          onChange={(e) => {
                            const next = new Set(selection.selected);
                            if (e.currentTarget.checked) {
                              next.add(run.id);
                            } else {
                              next.delete(run.id);
                            }
                            selection.onChange(next);
                          }}
                        />
                      </td>
                    )}
                    <td>
                      <Group spacing={4} noWrap>
                        <Anchor
                          component={Link}
                          to={`/runs/show/${run.id}`}
                          underline={false}
                          aria-label={`Open ${runLabel(run)}`}
                        >
                          <StatusBadge status={run.status} />
                        </Anchor>
                        {run.late && <LateBadge reasons={run.lateReasons} />}
                      </Group>
                    </td>
                    {showJob && (
                      <td>
                        <Anchor component={Link} to={`/jobs/show/${run.jobId}`} size="sm">
                          {run.jobName}
                        </Anchor>
                      </td>
                    )}
                    <td>
                      <Tooltip label={dateTime(run.scheduledAt)} withArrow openDelay={300}>
                        <Text size="sm" component="span">
                          {fromNow(run.scheduledAt)}
                          <span className="ct-sr-only">, {dateTime(run.scheduledAt)}</span>
                        </Text>
                      </Tooltip>
                    </td>
                    <td>
                      <Text size="sm" color="dimmed">
                        {REASON_LABEL[run.reason]}
                      </Text>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <Text size="sm">{run.attempts.length}</Text>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <Text size="sm" className="ct-mono">
                        {result?.statusCode ?? '—'}
                      </Text>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <Text size="sm">{duration(result?.durationMs)}</Text>
                    </td>
                    <td style={{ maxWidth: 320 }}>
                      <Text size="sm" color="dimmed" lineClamp={1} title={error || undefined}>
                        {error}
                      </Text>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </Table>
      </ScrollArea>
    </div>
  );
}
