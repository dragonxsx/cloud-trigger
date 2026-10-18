import { Alert, Button, Group, Pagination, Stack, Text } from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { CanAccess, useInvalidate, useTable } from '@refinedev/core';
import { IconChecks, IconRepeat } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

import { RunsTable } from '../../components/RunsTable';
import { type RunDto, client } from '../../lib/api';
import { notifyError } from '../../lib/errors';

const FAILED_INBOX = [
  { field: 'status', operator: 'in', value: ['failed', 'timed_out'] },
  { field: 'acknowledged', operator: 'eq', value: false },
] as const;

export function FailedRuns() {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const invalidate = useInvalidate();
  const { tableQuery, currentPage, setCurrentPage, pageCount } = useTable<RunDto>({
    resource: 'runs',
    pagination: { pageSize: 50 },
    filters: { permanent: [...FAILED_INBOX] },
    liveMode: 'auto',
    syncWithLocation: false,
  });
  const runs = tableQuery.data?.data ?? [];
  const ids = runs.filter((r) => selected.has(r.id)).map((r) => r.id);
  const done = async (message: string) => {
    showNotification({ color: 'green', message });
    setSelected(new Set());
    await invalidate({ resource: 'runs', invalidates: ['list'] });
  };
  const replay = useMutation({
    mutationFn: () => client.runs.replayMany({ ids }),
    onSuccess: async ({ results }) => {
      const failed = results.filter((r) => r.error !== null);
      if (failed.length > 0) {
        showNotification({
          color: 'orange',
          title: `${failed.length} could not be replayed`,
          message: failed.map((r) => r.error).join('; '),
        });
      }
      await done(`${results.length - failed.length} replays queued`);
    },
    onError: (e) => notifyError('Could not replay the runs', e),
  });
  const acknowledge = useMutation({
    mutationFn: () => client.runs.acknowledge({ ids }),
    onSuccess: ({ acknowledged }) => done(`${acknowledged} runs dismissed`),
    onError: (e) => notifyError('Could not dismiss the runs', e),
  });

  return (
    <Stack spacing="md">
      <Group position="apart">
        <Text size="sm" color="dimmed">
          Runs that failed after their last attempt. Replay them, or dismiss them once handled;
          dismissing keeps the history.
        </Text>
        <Group spacing="xs">
          <CanAccess resource="runs" action="replay">
            <Button
              variant="default"
              leftIcon={<IconRepeat size={16} />}
              disabled={ids.length === 0}
              loading={replay.isPending}
              onClick={() => replay.mutate()}
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
              onClick={() => acknowledge.mutate()}
            >
              Dismiss {ids.length > 0 ? ids.length : ''}
            </Button>
          </CanAccess>
        </Group>
      </Group>
      {runs.length === 0 && !tableQuery.isLoading ? (
        <Alert color="gray" title="Nothing to triage">
          No unhandled failed runs.
        </Alert>
      ) : (
        <RunsTable runs={runs} selection={{ selected, onChange: setSelected }} />
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
