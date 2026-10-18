import { Anchor, Checkbox, Group, ScrollArea, Table, Text } from '@mantine/core';
import { Link } from 'react-router';

import type { RunDto } from '../lib/api';
import { dateTime, duration, fromNow } from '../lib/format';
import { LateBadge, StatusBadge } from '../lib/status';

export const lastResult = (run: RunDto) =>
  run.status === 'succeeded' ||
  run.status === 'failed' ||
  run.status === 'timed_out' ||
  run.status === 'cancelled'
    ? run.result
    : run.attempts.at(-1)?.result;

export interface RunSelection {
  readonly selected: ReadonlySet<string>;
  readonly onChange: (selected: ReadonlySet<string>) => void;
}

export function RunsTable({
  runs,
  showJob = true,
  selection,
}: {
  runs: readonly RunDto[];
  showJob?: boolean;
  selection?: RunSelection | undefined;
}) {
  if (runs.length === 0) {
    return (
      <Text color="dimmed" p="lg" align="center">
        No runs match. Runs appear here as soon as a job fires or you use Run now.
      </Text>
    );
  }

  return (
    <ScrollArea>
      <Table highlightOnHover verticalSpacing="xs" className="ct-table" miw={760}>
        <thead>
          <tr>
            {selection && (
              <th style={{ width: 36 }}>
                <Checkbox
                  aria-label="Select all"
                  checked={runs.length > 0 && runs.every((r) => selection.selected.has(r.id))}
                  indeterminate={
                    runs.some((r) => selection.selected.has(r.id)) &&
                    !runs.every((r) => selection.selected.has(r.id))
                  }
                  onChange={(e) =>
                    selection.onChange(
                      new Set(e.currentTarget.checked ? runs.map((r) => r.id) : []),
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
          {runs.map((run) => {
            const result = lastResult(run);

            return (
              <tr key={run.id}>
                {selection && (
                  <td>
                    <Checkbox
                      aria-label={`Select run ${run.id}`}
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
                    <Anchor component={Link} to={`/runs/show/${run.id}`} underline={false}>
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
                <td title={dateTime(run.scheduledAt)}>
                  <Text size="sm">{fromNow(run.scheduledAt)}</Text>
                </td>
                <td>
                  <Text size="sm" color="dimmed">
                    {run.reason}
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
                  <Text size="sm" color="dimmed" lineClamp={1}>
                    {run.status === 'skipped' ? run.skipReason : (result?.error?.message ?? '')}
                  </Text>
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </ScrollArea>
  );
}
