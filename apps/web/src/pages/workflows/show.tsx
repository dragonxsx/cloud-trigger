import { Anchor, Button, ScrollArea, Stack, Table, Text } from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { CanAccess, useShow } from '@refinedev/core';
import { DeleteButton, EditButton, Show } from '@refinedev/mantine';
import { IconPlayerTrackNext } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';

import { WorkflowGraph } from '../../components/WorkflowGraph';
import { type WorkflowDto, client } from '../../lib/api';
import { notifyError } from '../../lib/errors';
import { dateTime, fromNow } from '../../lib/format';
import { WorkflowRunBadge } from './run';

function RunNowButton({ workflow }: { workflow: WorkflowDto }) {
  const navigate = useNavigate();
  const start = useMutation({
    mutationFn: () => client.workflows.run({ id: workflow.id }),
    onSuccess: async (run) => {
      showNotification({ color: 'green', message: 'Workflow started' });
      await navigate(`/workflows/runs/${run.id}`);
    },
    onError: (e) => notifyError('Could not start the workflow', e),
  });

  return (
    <CanAccess resource="workflows" action="run">
      <Button
        leftIcon={<IconPlayerTrackNext size={16} />}
        loading={start.isPending}
        disabled={!workflow.enabled}
        onClick={() => start.mutate()}
      >
        Run now
      </Button>
    </CanAccess>
  );
}

function RecentRuns({ workflow }: { workflow: WorkflowDto }) {
  const runs = useQuery({
    queryKey: ['workflow-runs', workflow.id],
    queryFn: () => client.workflowRuns.list({ workflowId: workflow.id, limit: 20 }),
    refetchInterval: 5_000,
  });
  const items = runs.data?.items ?? [];

  return (
    <Stack className="ct-panel" p="lg" spacing="xs">
      <Text weight={600}>Recent runs</Text>
      {items.length === 0 ? (
        <Text size="sm" color="dimmed">
          No runs yet.
        </Text>
      ) : (
        <ScrollArea>
          <Table verticalSpacing={4} fontSize="sm" className="ct-table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Status</th>
                <th>Reason</th>
                <th>Finished</th>
              </tr>
            </thead>
            <tbody>
              {items.map((run) => (
                <tr key={run.id}>
                  <td>
                    <Anchor component={Link} to={`/workflows/runs/${run.id}`} size="sm">
                      {dateTime(run.startedAt)}
                    </Anchor>
                  </td>
                  <td>
                    <WorkflowRunBadge status={run.status} />
                  </td>
                  <td>{run.reason}</td>
                  <td>{fromNow(run.finishedAt)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </ScrollArea>
      )}
    </Stack>
  );
}

export function WorkflowShow() {
  const { query } = useShow<WorkflowDto>({ resource: 'workflows' });
  const workflow = query.data?.data;

  return (
    <Show
      isLoading={query.isLoading}
      title={workflow?.name ?? 'Workflow'}
      headerButtons={
        workflow ? (
          <>
            <RunNowButton workflow={workflow} />
            <EditButton recordItemId={workflow.id} />
            <DeleteButton recordItemId={workflow.id} />
          </>
        ) : undefined
      }
    >
      {workflow && (
        <Stack spacing="lg">
          {workflow.description && <Text color="dimmed">{workflow.description}</Text>}
          <Text size="sm" color="dimmed">
            {workflow.schedule
              ? `Scheduled (${workflow.schedule.type}); next run ${fromNow(workflow.nextFireAt)}.`
              : 'Started by hand or through the API.'}
          </Text>
          <WorkflowGraph nodes={workflow.nodes} edges={workflow.edges} height={360} />
          <RecentRuns workflow={workflow} />
        </Stack>
      )}
    </Show>
  );
}
