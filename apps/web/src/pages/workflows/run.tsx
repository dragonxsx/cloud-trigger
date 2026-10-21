import { RUN_STATUS_STYLE } from '@cloud-trigger/core';
import { Alert, Anchor, Badge, Button, Group, ScrollArea, Stack, Table, Text } from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { CanAccess } from '@refinedev/core';
import { Show } from '@refinedev/mantine';
import { IconCheck, IconPlayerStop, IconUserCheck, IconX } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';

import { confirmAction } from '../../components/confirm';
import { PageHeading, backIcon, pageBreadcrumb } from '../../components/page-chrome';
import { RecordLoadError } from '../../components/PageState';
import { usePageTitle } from '../../components/usePageTitle';
import { NodeStatusBadge, WorkflowGraph } from '../../components/WorkflowGraph';
import { type WorkflowRunDto, client } from '../../lib/api';
import { notifyError, toHttpError } from '../../lib/errors';
import { dateTime, fromNow } from '../../lib/format';

const RUN_STATUS: Record<WorkflowRunDto['status'], { label: string; color: string }> = {
  running: RUN_STATUS_STYLE.running,
  succeeded: RUN_STATUS_STYLE.succeeded,
  failed: RUN_STATUS_STYLE.failed,
  cancelled: RUN_STATUS_STYLE.cancelled,
};

export const RUN_REASON: Record<WorkflowRunDto['reason'], string> = {
  manual: 'Started by hand',
  scheduled: 'Schedule',
};

const stepRowId = (key: string) => `workflow-run-step-${key}`;

export function WorkflowRunBadge({ status }: { status: WorkflowRunDto['status'] }) {
  return (
    <Badge
      variant="dot"
      color={RUN_STATUS[status].color}
      radius="sm"
      styles={{ root: { textTransform: 'none', fontWeight: 600 } }}
    >
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
      showNotification({
        color: 'green',
        message: approved ? `Approved ${node}` : `Rejected ${node}`,
      });
      await queryClient.invalidateQueries({ queryKey: ['workflow-run', run.id] });
    },
    onError: (e) => notifyError('Could not record the decision', e),
  });
  const deciding = (approved: boolean) => decide.isPending && decide.variables === approved;

  return (
    <CanAccess resource="workflows" action="run">
      <Group spacing="xs" noWrap>
        <Button
          size="sm"
          color="green"
          leftIcon={<IconCheck size={16} />}
          loading={deciding(true)}
          disabled={deciding(false)}
          onClick={() => decide.mutate(true)}
        >
          Approve
        </Button>
        <Button
          size="sm"
          color="red"
          variant="light"
          leftIcon={<IconX size={16} />}
          loading={deciding(false)}
          disabled={deciding(true)}
          onClick={() =>
            void confirmAction({
              title: `Reject ${node}?`,
              message: 'The gate fails, so steps that need it to succeed won’t run.',
              confirmLabel: 'Reject',
              cancelLabel: 'Go back',
              onConfirm: () => decide.mutate(false),
            })
          }
        >
          Reject
        </Button>
      </Group>
    </CanAccess>
  );
}

function PendingApprovals({ run }: { run: WorkflowRunDto }) {
  if (run.status !== 'running') {
    return null;
  }
  const gates = run.graph.nodes.filter(
    (node) => run.nodes[node.key]?.status === 'waiting_approval',
  );
  if (gates.length === 0) {
    return null;
  }

  return (
    <Alert
      color="orange"
      icon={<IconUserCheck size={18} />}
      title={
        gates.length === 1 ? 'Waiting for approval' : `${gates.length} gates waiting for approval`
      }
    >
      <Stack spacing="sm">
        <Text size="sm">Someone with write access has to approve or reject each gate.</Text>
        {gates.map((node) => {
          const deadline = run.nodes[node.key]?.deadline;

          return (
            <Group key={node.key} position="apart" spacing="sm">
              <div>
                <Text size="sm" weight={600} className="ct-mono">
                  {node.key}
                </Text>
                {node.label && <Text size="sm">{node.label}</Text>}
                {deadline && (
                  <Text size="xs" title={dateTime(deadline)}>
                    Fails {fromNow(deadline)} if nobody decides
                  </Text>
                )}
              </div>
              <Decision run={run} node={node.key} />
            </Group>
          );
        })}
      </Stack>
    </Alert>
  );
}

function CancelButton({ run }: { run: WorkflowRunDto | undefined }) {
  return run?.status === 'running' ? <CancelRunButton run={run} /> : null;
}

function CancelRunButton({ run }: { run: WorkflowRunDto }) {
  const queryClient = useQueryClient();
  const cancel = useMutation({
    mutationFn: () => client.workflowRuns.cancel({ id: run.id }),
    onSuccess: async () => {
      showNotification({ color: 'green', message: 'Workflow run cancelled' });
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
        onClick={() =>
          void confirmAction({
            title: 'Cancel this run?',
            message: 'Running steps are cancelled and the remaining steps don’t start.',
            confirmLabel: 'Cancel run',
            cancelLabel: 'Keep running',
            onConfirm: () => cancel.mutate(),
          })
        }
      >
        Cancel run
      </Button>
    </CanAccess>
  );
}

const focusStepRow = (key: string) => {
  const row = document.getElementById(stepRowId(key));
  row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row?.focus({ preventScroll: true });
};

export function WorkflowRunShow() {
  const { id = '' } = useParams();
  const query = useQuery({
    queryKey: ['workflow-run', id],
    queryFn: () => client.workflowRuns.get({ id }),
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 2_000 : false),
  });
  const run = query.data;
  usePageTitle(run ? `${run.workflowName} run` : undefined, 'Workflows');
  const statuses = run
    ? Object.fromEntries(Object.entries(run.nodes).map(([key, state]) => [key, state.status]))
    : {};

  if (query.isError) {
    return (
      <RecordLoadError
        error={toHttpError(query.error, { notFoundOnInvalid: true })}
        onRetry={() => void query.refetch()}
        resource="Workflow run"
        listPath="/workflows"
        listLabel="Workflows"
      />
    );
  }

  return (
    <Show
      isLoading={query.isLoading}
      goBack={backIcon}
      breadcrumb={pageBreadcrumb}
      title={<PageHeading>{run ? `${run.workflowName} run` : 'Workflow run'}</PageHeading>}
      resource="workflows"
      canEdit={false}
      canDelete={false}
      headerButtons={<CancelButton run={run} />}
    >
      {run && (
        <Stack spacing="lg">
          <Group spacing="sm">
            <WorkflowRunBadge status={run.status} />
            <Text size="sm" color="dimmed">
              {RUN_REASON[run.reason]} · started {dateTime(run.startedAt)}
              {run.finishedAt ? ` · finished ${fromNow(run.finishedAt)}` : ''}
            </Text>
            <Anchor component={Link} to={`/workflows/show/${run.workflowId}`} size="sm">
              Open workflow
            </Anchor>
          </Group>
          <PendingApprovals run={run} />
          <WorkflowGraph
            nodes={run.graph.nodes}
            edges={run.graph.edges}
            statuses={statuses}
            onNodeClick={focusStepRow}
          />
          <ScrollArea className="ct-panel">
            <Table verticalSpacing="xs" fontSize="sm" className="ct-table" miw={520}>
              <thead>
                <tr>
                  <th>Step</th>
                  <th>Status</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {run.graph.nodes.map((node) => {
                  const state = run.nodes[node.key];

                  return (
                    <tr key={node.key} id={stepRowId(node.key)} tabIndex={-1}>
                      <td className="ct-mono">{node.key}</td>
                      <td>{state ? <NodeStatusBadge status={state.status} /> : '—'}</td>
                      <td>
                        <Group spacing={6}>
                          {state?.runId && (
                            <Anchor component={Link} to={`/runs/show/${state.runId}`} size="sm">
                              Open job run
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
