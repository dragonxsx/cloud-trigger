import {
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  ScrollArea,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { CanAccess, useList, useNavigation, useNotification, useShow } from '@refinedev/core';
import { DeleteButton, EditButton, Show } from '@refinedev/mantine';
import { IconPlayerTrackNext } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router';

import { PageHeading, backIcon, pageBreadcrumb } from '../../components/page-chrome';
import { LoadError, PageLoader, RecordLoadError } from '../../components/PageState';
import { usePageTitle } from '../../components/usePageTitle';
import { KIND_LABEL, WorkflowGraph } from '../../components/WorkflowGraph';
import { type WorkflowDto, type WorkflowRunDto, client } from '../../lib/api';
import { notifyError } from '../../lib/errors';
import { dateTime, fromNow } from '../../lib/format';
import { triggerSummary } from '../../lib/job-summary';
import { RUN_REASON, WorkflowRunBadge } from './run';

const EDGE_TEXT = { succeeded: 'succeeds', failed: 'fails', any: 'finishes' } as const;

function RunNowButton({ workflow }: { workflow: WorkflowDto }) {
  const { show } = useNavigation();
  const { open } = useNotification();
  const start = useMutation({
    mutationFn: () => client.workflows.run({ id: workflow.id }),
    onSuccess: (run) => {
      open?.({ type: 'success', message: 'Workflow started' });
      show('workflow-runs', run.id);
    },
    onError: (e) => notifyError('Could not start the workflow', e),
  });

  return (
    <CanAccess resource="workflows" action="run">
      <Tooltip
        label="This workflow is disabled. Edit it and turn on Enabled to run it."
        disabled={workflow.enabled}
        withArrow
        multiline
        width={240}
        events={{ hover: true, focus: true, touch: true }}
      >
        <span tabIndex={workflow.enabled ? undefined : 0}>
          <Button
            leftIcon={<IconPlayerTrackNext size={16} />}
            loading={start.isPending}
            disabled={!workflow.enabled}
            onClick={() => start.mutate()}
          >
            Run now
          </Button>
        </span>
      </Tooltip>
    </CanAccess>
  );
}

function StepList({ workflow }: { workflow: WorkflowDto }) {
  return (
    <Stack className="ct-panel" p="lg" spacing="xs">
      <Title order={2} size="h4">
        Steps
      </Title>
      <ScrollArea>
        <Table verticalSpacing={4} fontSize="sm" className="ct-table">
          <thead>
            <tr>
              <th>Step</th>
              <th>Kind</th>
              <th>Starts</th>
            </tr>
          </thead>
          <tbody>
            {workflow.nodes.map((node) => {
              const incoming = workflow.edges.filter((edge) => edge.to === node.key);

              return (
                <tr key={node.key}>
                  <td>
                    <Text size="sm" className="ct-mono" weight={600}>
                      {node.key}
                    </Text>
                    {node.label && (
                      <Text size="xs" color="dimmed">
                        {node.label}
                      </Text>
                    )}
                  </td>
                  <td>{KIND_LABEL[node.kind]}</td>
                  <td>
                    {incoming.length === 0
                      ? 'When the workflow starts'
                      : `After ${incoming
                          .map((edge) => `${edge.from} ${EDGE_TEXT[edge.on]}`)
                          .join(' and ')}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </ScrollArea>
    </Stack>
  );
}

function RecentRuns({ workflow }: { workflow: WorkflowDto }) {
  const { showUrl } = useNavigation();
  const { result, query } = useList<WorkflowRunDto>({
    resource: 'workflow-runs',
    filters: [{ field: 'workflowId', operator: 'eq', value: workflow.id }],
    pagination: { pageSize: 20 },
    errorNotification: false,
    queryOptions: { refetchInterval: 5_000 },
  });
  const items = result.data;

  return (
    <Stack className="ct-panel" p="lg" spacing="xs">
      <Title order={2} size="h4">
        Recent runs
      </Title>
      {query.isError ? (
        <LoadError error={query.error} what="recent runs" onRetry={() => void query.refetch()} />
      ) : query.isLoading ? (
        <PageLoader label="Loading runs…" />
      ) : items.length === 0 ? (
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
                <th>Started by</th>
                <th>Finished</th>
              </tr>
            </thead>
            <tbody>
              {items.map((run) => (
                <tr key={run.id}>
                  <td>
                    <Anchor component={Link} to={showUrl('workflow-runs', run.id)} size="sm">
                      {dateTime(run.startedAt)}
                    </Anchor>
                  </td>
                  <td>
                    <WorkflowRunBadge status={run.status} />
                  </td>
                  <td>{RUN_REASON[run.reason]}</td>
                  <td title={dateTime(run.finishedAt)}>{fromNow(run.finishedAt)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </ScrollArea>
      )}
    </Stack>
  );
}

function WorkflowHeaderButtons({ workflow }: { workflow: WorkflowDto | undefined }) {
  const { list } = useNavigation();
  if (!workflow) {
    return null;
  }

  return (
    <Group spacing="xs">
      <RunNowButton workflow={workflow} />
      <EditButton recordItemId={workflow.id} />
      <DeleteButton
        recordItemId={workflow.id}
        onSuccess={() => list('workflows')}
        confirmTitle={`Delete ${workflow.name}? Its inline jobs are deleted too.`}
        confirmOkText="Delete workflow"
        confirmCancelText="Cancel"
      />
    </Group>
  );
}

export function WorkflowShow() {
  const { query } = useShow<WorkflowDto>({ resource: 'workflows', errorNotification: false });
  const workflow = query.data?.data;
  usePageTitle(workflow?.name, 'Workflows');

  if (query.isError) {
    return (
      <RecordLoadError
        error={query.error}
        onRetry={() => void query.refetch()}
        resource="Workflow"
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
      title={
        <Group spacing="sm">
          <PageHeading>{workflow?.name ?? 'Workflow'}</PageHeading>
          {workflow && !workflow.enabled && (
            <Badge color="gray" variant="outline" radius="sm">
              Disabled
            </Badge>
          )}
        </Group>
      }
      headerButtons={<WorkflowHeaderButtons workflow={workflow} />}
    >
      {workflow && (
        <Stack spacing="lg">
          {workflow.description && <Text color="dimmed">{workflow.description}</Text>}
          {!workflow.enabled && (
            <Alert color="gray" title="Disabled">
              This workflow doesn&apos;t run on its schedule and can&apos;t be started by hand. Edit
              it and turn on Enabled to use it again.
            </Alert>
          )}
          <Text size="sm" color="dimmed">
            {workflow.schedule
              ? `${triggerSummary({ trigger: workflow.schedule })}. Next run ${fromNow(workflow.nextFireAt)}.`
              : 'Started by hand or through the API.'}
          </Text>
          <WorkflowGraph nodes={workflow.nodes} edges={workflow.edges} />
          <StepList workflow={workflow} />
          <RecentRuns workflow={workflow} />
        </Stack>
      )}
    </Show>
  );
}
