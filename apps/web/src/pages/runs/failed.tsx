import { Alert, Button, Group, List, Pagination, Stack, Text } from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { CanAccess, useInvalidate, useTable } from '@refinedev/core';
import { IconChecks, IconRepeat } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

import { confirmAction } from '../../components/confirm';
import { LoadError } from '../../components/PageState';
import { RunsTable } from '../../components/RunsTable';
import { type RunDto, client } from '../../lib/api';
import { notifyError } from '../../lib/errors';

export const FAILED_INBOX = [
  { field: 'status', operator: 'in', value: ['failed', 'timed_out'] },
  { field: 'acknowledged', operator: 'eq', value: false },
] as const;

const PREVIEW = 5;

const plural = (count: number, word: string): string =>
  `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;

function SelectionSummary({ runs }: { runs: readonly RunDto[] }) {
  const jobs = [...new Set(runs.map((r) => r.jobName))];

  return (
    <Stack spacing={6}>
      <Text size="sm">
        {plural(runs.length, 'run')} from {plural(jobs.length, 'job')}:
      </Text>
      <List size="sm" spacing={2}>
        {jobs.slice(0, PREVIEW).map((name) => (
          <List.Item key={name}>{name}</List.Item>
        ))}
        {jobs.length > PREVIEW && <List.Item>and {jobs.length - PREVIEW} more</List.Item>}
      </List>
    </Stack>
  );
}

export function FailedRuns() {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const invalidate = useInvalidate();
  const { tableQuery, currentPage, setCurrentPage, pageCount } = useTable<RunDto>({
    resource: 'runs',
    pagination: { pageSize: 50 },
    filters: { permanent: [...FAILED_INBOX] },
    liveMode: selected.size > 0 ? 'manual' : 'auto',
    syncWithLocation: false,
  });
  const runs = tableQuery.data?.data ?? [];
  const chosen = runs.filter((r) => selected.has(r.id));
  const ids = chosen.map((r) => r.id);
  const done = async (message: string) => {
    showNotification({ color: 'green', message });
    setSelected(new Set());
    await invalidate({ resource: 'runs', invalidates: ['list'] });
  };
  const replay = useMutation({
    mutationFn: (runIds: readonly string[]) => client.runs.replayMany({ ids: [...runIds] }),
    onSuccess: async ({ results }) => {
      const failed = results.filter((r) => r.error !== null);
      if (failed.length > 0) {
        showNotification({
          color: 'orange',
          title: `${plural(failed.length, 'run')} could not be replayed`,
          message: failed.map((r) => r.error).join('; '),
        });
      }
      await done(`${plural(results.length - failed.length, 'replay')} queued`);
    },
    onError: (e) => notifyError('Could not replay the runs', e),
  });
  const acknowledge = useMutation({
    mutationFn: (runIds: readonly string[]) => client.runs.acknowledge({ ids: [...runIds] }),
    onSuccess: ({ acknowledged }) =>
      done(`${plural(acknowledged, 'run')} dismissed. They stay in All runs.`),
    onError: (e) => notifyError('Could not dismiss the runs', e),
  });

  const confirmReplay = () => {
    const runIds = ids;
    void confirmAction({
      title: `Replay ${plural(runIds.length, 'run')}?`,
      message: (
        <Stack spacing="xs">
          <SelectionSummary runs={chosen} />
          <Text size="sm" color="dimmed">
            Each run is queued again with its original input, and calls its endpoint again.
          </Text>
        </Stack>
      ),
      confirmLabel: `Replay ${plural(runIds.length, 'run')}`,
      danger: false,
      onConfirm: () => replay.mutate(runIds),
    });
  };
  const confirmDismiss = () => {
    const runIds = ids;
    void confirmAction({
      title: `Dismiss ${plural(runIds.length, 'run')}?`,
      message: (
        <Stack spacing="xs">
          <SelectionSummary runs={chosen} />
          <Text size="sm" color="dimmed">
            They leave this inbox and can't be brought back here. Their history stays in All runs.
          </Text>
        </Stack>
      ),
      confirmLabel: `Dismiss ${plural(runIds.length, 'run')}`,
      onConfirm: () => acknowledge.mutate(runIds),
    });
  };

  return (
    <Stack spacing="md">
      <Group position="apart" spacing="sm">
        <Text size="sm" color="dimmed" sx={{ flex: '1 1 320px', minWidth: 0 }}>
          Runs that failed after their last attempt. Replay them, or dismiss them once handled;
          dismissing keeps the history.
          {selected.size > 0 && ' New failures are held back while you have runs selected.'}
        </Text>
        <Group spacing="xs">
          <CanAccess resource="runs" action="replay">
            <Button
              variant="default"
              leftIcon={<IconRepeat size={16} />}
              disabled={ids.length === 0}
              loading={replay.isPending}
              onClick={confirmReplay}
            >
              Replay {ids.length > 0 ? ids.length : ''}
            </Button>
          </CanAccess>
          <CanAccess resource="runs" action="acknowledge">
            <Button
              variant="default"
              leftIcon={<IconChecks size={16} />}
              disabled={ids.length === 0}
              loading={acknowledge.isPending}
              onClick={confirmDismiss}
            >
              Dismiss {ids.length > 0 ? ids.length : ''}
            </Button>
          </CanAccess>
        </Group>
      </Group>
      {tableQuery.isError ? (
        <LoadError
          error={tableQuery.error}
          what="failed runs"
          onRetry={() => {
            void tableQuery.refetch();
          }}
        />
      ) : runs.length === 0 && !tableQuery.isLoading ? (
        <Alert color="gray" title="Nothing to triage">
          No unhandled failed runs.
        </Alert>
      ) : (
        <RunsTable
          runs={runs}
          loading={tableQuery.isLoading}
          selection={{ selected, onChange: setSelected }}
        />
      )}
      {pageCount > 1 && (
        <Pagination
          page={currentPage}
          total={pageCount}
          onChange={setCurrentPage}
          position="right"
        />
      )}
    </Stack>
  );
}
