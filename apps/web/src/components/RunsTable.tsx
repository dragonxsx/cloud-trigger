import { Anchor, ScrollArea, Table, Text } from '@mantine/core';
import { Link } from 'react-router';

import type { RunDto } from '../lib/api';
import { dateTime, duration, fromNow } from '../lib/format';
import { StatusBadge } from '../lib/status';

export const lastResult = (run: RunDto) =>
  run.status === 'succeeded' ||
  run.status === 'failed' ||
  run.status === 'timed_out' ||
  run.status === 'cancelled'
    ? run.result
    : run.attempts.at(-1)?.result;

export function RunsTable({
  runs,
  showJob = true,
}: {
  runs: readonly RunDto[];
  showJob?: boolean;
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
                <td>
                  <Anchor component={Link} to={`/runs/show/${run.id}`} underline={false}>
                    <StatusBadge status={run.status} />
                  </Anchor>
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
