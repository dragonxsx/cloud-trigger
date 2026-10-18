import { RUN_STATUS_STYLE } from '@cloud-trigger/core';
import { Anchor, Badge, Button, Group, ScrollArea, Stack, Table, Text } from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { CanAccess } from '@refinedev/core';
import { Show } from '@refinedev/mantine';
import { IconCheck, IconPlayerStop, IconX } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';

import { WorkflowGraph } from '../../components/WorkflowGraph';
import { type WorkflowRunDto, client } from '../../lib/api';
import { notifyError } from '../../lib/errors';
import { dateTime, fromNow } from '../../lib/format';

const RUN_STATUS: Record<WorkflowRunDto['status'], { label: string; color: string }> = {
  running: RUN_STATUS_STYLE.running,
  succeeded: RUN_STATUS_STYLE.succeeded,
  failed: RUN_STATUS_STYLE.failed,
  cancelled: RUN_STATUS_STYLE.cancelled,
};

export function WorkflowRunBadge({ status }: { status: WorkflowRunDto['status'] }) {
  return (
    <Badge variant="dot" color="gray" styles={{ root: { color: RUN_STATUS[status].color } }}>
      {RUN_STATUS[status].label}
    </Badge>
  );
}

function Decision({ run, node }: { run: WorkflowRunDto; node: string }) {
  const queryClient = useQueryClient();
  const decide = useMutation({
    mutationFn: (approved: boolean) =>
      approved
        ? client.workflowRuns.approve({ id: run.id, node })
        : client.workflowRuns.reject({ id: run.id, node }),
    onSuccess: async (_next, approved) => {
      showNotification({ color: 'green', message: approved ? 'Approved' : 'Rejected' });
      await queryClient.invalidateQueries({ queryKey: ['workflow-run', run.id] });
    },
    onError: (e) => notifyError('Could not record the decision', e),
  });

  return (
    <CanAccess resource="workflows" action="run">
      <Group spacing="xs">
        <Button
          size="xs"
          color="green"
          leftIcon={<IconCheck size={14} />}
          loading={decide.isPending}
          onClick={() => decide.mutate(true)}
        >
          Approve
        </Button>
        <Button
          size="xs"
          color="red"
          variant="light"
          leftIcon={<IconX size={14} />}
          loading={decide.isPending}
          onClick={() => decide.mutate(false)}
        >
          Reject
        </Button>
      </Group>
    </CanAccess>
  );
}

function CancelButton({ run }: { run: WorkflowRunDto }) {
  const queryClient = useQueryClient();
  const cancel = useMutation({
    mutationFn: () => client.workflowRuns.cancel({ id: run.id }),
    onSuccess: async () => {
      showNotification({ color: 'green', message: 'Workflow cancelled' });
      await queryClient.invalidateQueries({ queryKey: ['workflow-run', run.id] });
    },
    onError: (e) => notifyError('Could not cancel the workflow', e),
  });

  return (
    <CanAccess resource="workflows" action="run">
      <Button
        color="red"
        variant="light"
        leftIcon={<IconPlayerStop size={16} />}
        loading={cancel.isPending}
        disabled={run.status !== 'running'}
        onClick={() => cancel.mutate()}
      >
        Cancel
      </Button>
    </CanAccess>
  );
}

export function WorkflowRunShow() {
  const { id = '' } = useParams();
  const query = useQuery({
    queryKey: ['workflow-run', id],
    queryFn: () => client.workflowRuns.get({ id }),
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 2_000 : false),
  });
  const run = query.data;
  const statuses = run
    ? Object.fromEntries(Object.entries(run.nodes).map(([key, state]) => [key, state.status]))
    : {};

  return (
    <Show
      isLoading={query.isLoading}
      title={run ? `${run.workflowName} run` : 'Workflow run'}
      resource="workflows"
      canEdit={false}
      canDelete={false}
      headerButtons={run ? <CancelButton run={run} /> : undefined}
    >
      {run && (
        <Stack spacing="lg">
          <Group spacing="sm">
            <WorkflowRunBadge status={run.status} />
            <Text size="sm" color="dimmed">
              {run.reason} · started {dateTime(run.startedAt)}
              {run.finishedAt ? ` · finished ${fromNow(run.finishedAt)}` : ''}
            </Text>
            <Anchor component={Link} to={`/workflows/show/${run.workflowId}`} size="sm">
              Workflow
            </Anchor>
          </Group>
          <WorkflowGraph
            nodes={run.graph.nodes}
            edges={run.graph.edges}
            statuses={statuses}
            height={360}
          />
          <ScrollArea className="ct-panel">
            <Table verticalSpacing="xs" fontSize="sm" className="ct-table" miw={640}>
              <thead>
                <tr>
                  <th>Step</th>
                  <th>Status</th>
                  <th>Detail</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {run.graph.nodes.map((node) => {
                  const state = run.nodes[node.key];

                  return (
                    <tr key={node.key}>
                      <td className="ct-mono">{node.key}</td>
                      <td>{state?.status.replace('_', ' ')}</td>
                      <td>
                        <Group spacing={6}>
                          {state?.runId && (
                            <Anchor component={Link} to={`/runs/show/${state.runId}`} size="sm">
                              Run
                            </Anchor>
                          )}
                          <Text size="sm" color="dimmed">
                            {[
                              state?.reason,
                              state?.decidedBy ? `by ${state.decidedBy}` : undefined,
                              state?.deadline ? `times out ${fromNow(state.deadline)}` : undefined,
                            ]
                              .filter((part) => part !== undefined && part !== null)
                              .join(' · ')}
                          </Text>
                        </Group>
                      </td>
                      <td>
                        {state?.status === 'waiting_approval' && run.status === 'running' && (
                          <Decision run={run} node={node.key} />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </ScrollArea>
        </Stack>
      )}
    </Show>
  );
}
