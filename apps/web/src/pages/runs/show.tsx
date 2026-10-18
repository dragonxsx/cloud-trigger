import { FanoutMetadata } from '@cloud-trigger/core';
import {
  Anchor,
  Button,
  Code,
  Group,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  Timeline,
} from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { CanAccess, useInvalidate, useShow } from '@refinedev/core';
import { Show } from '@refinedev/mantine';
import { IconPlayerStop, IconRepeat } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';

import { RunNotifications } from '../../components/RunNotifications';
import { lastResult } from '../../components/RunsTable';
import { type RunDto, client } from '../../lib/api';
import { notifyError } from '../../lib/errors';
import { dateTime, duration } from '../../lib/format';
import { STATUS, StatusBadge } from '../../lib/status';

type Attempt = RunDto['attempts'][number];

const prettyBody = (body: string | undefined): string => {
  if (!body) {
    return '(empty)';
  }
  try {
    const parsed: unknown = JSON.parse(body);

    return JSON.stringify(parsed, null, 2);
  } catch {
    return body;
  }
};

function FanoutChildren({ metadata }: { metadata: FanoutMetadata }) {
  return (
    <Table fontSize="sm" verticalSpacing={4}>
      <thead>
        <tr>
          <th>Target</th>
          <th>Outcome</th>
          <th>Duration</th>
          <th>Detail</th>
        </tr>
      </thead>
      <tbody>
        {metadata.children.map((child) => (
          <tr key={child.index}>
            <td>
              {child.name ?? `#${child.index + 1}`}{' '}
              <Text component="span" color="dimmed" className="ct-mono">
                {child.type}
              </Text>
            </td>
            <td>
              <StatusBadge status={child.outcome === 'success' ? 'succeeded' : 'failed'} />
            </td>
            <td>{duration(child.durationMs)}</td>
            <td>
              {child.error ? (
                <>
                  <b className="ct-mono">{child.error.code}</b> {child.error.message}
                </>
              ) : child.statusCode !== undefined ? (
                `status ${child.statusCode}`
              ) : (
                ''
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function AttemptDetail({ attempt }: { attempt: Attempt }) {
  const { result } = attempt;
  const fanout = FanoutMetadata.safeParse(result.metadata);
  const hasMetadata = result.metadata !== undefined && Object.keys(result.metadata).length > 0;

  return (
    <Stack spacing="xs">
      <Text size="sm" color="dimmed">
        {dateTime(attempt.startedAt)} · {duration(result.durationMs)} · worker {attempt.workerId}
        {result.statusCode !== undefined && ` · HTTP ${result.statusCode}`}
      </Text>
      {result.error && (
        <Text size="sm">
          <b className="ct-mono">{result.error.code}</b> {result.error.message}
          {result.error.retryable ? ' (retryable)' : ''}
        </Text>
      )}
      {fanout.success && (
        <Text size="sm" color="dimmed">
          Fan-out ({fanout.data.mode === 'all' ? 'all must succeed' : 'any may succeed'})
        </Text>
      )}
      {fanout.success && <FanoutChildren metadata={fanout.data} />}
      {!fanout.success && hasMetadata && !result.response && (
        <Code block>{JSON.stringify(result.metadata, null, 2)}</Code>
      )}
      {result.response && (
        <Tabs defaultValue="body" variant="outline">
          <Tabs.List>
            <Tabs.Tab value="body">
              Response body{result.response.truncated ? ' (truncated)' : ''}
            </Tabs.Tab>
            <Tabs.Tab value="headers">Headers</Tabs.Tab>
            {hasMetadata && !fanout.success && <Tabs.Tab value="metadata">Metadata</Tabs.Tab>}
          </Tabs.List>
          <Tabs.Panel value="body" pt="xs">
            <Code block>{prettyBody(result.response.body)}</Code>
          </Tabs.Panel>
          <Tabs.Panel value="headers" pt="xs">
            <Code block>{JSON.stringify(result.response.headers ?? {}, null, 2)}</Code>
          </Tabs.Panel>
          <Tabs.Panel value="metadata" pt="xs">
            <Code block>{JSON.stringify(result.metadata ?? {}, null, 2)}</Code>
          </Tabs.Panel>
        </Tabs>
      )}
    </Stack>
  );
}

type RunEventDto = NonNullable<RunDto['event']>;

function InboundEvent({ event }: { event: RunEventDto }) {
  return (
    <Stack className="ct-panel" p="lg" spacing="xs">
      <Text weight={600}>Inbound {event.kind === 'webhook' ? 'webhook' : 'message'}</Text>
      <Text size="sm" color="dimmed">
        {event.source} · {event.id} · received {dateTime(event.receivedAt)}
      </Text>
      <Tabs defaultValue="body" variant="outline">
        <Tabs.List>
          <Tabs.Tab value="body">Body</Tabs.Tab>
          <Tabs.Tab value="headers">Headers</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="body" pt="xs">
          <Code block>{prettyBody(event.body)}</Code>
        </Tabs.Panel>
        <Tabs.Panel value="headers" pt="xs">
          <Code block>{JSON.stringify(event.headers, null, 2)}</Code>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

function RunActions({ run }: { run: RunDto }) {
  const invalidate = useInvalidate();
  const navigate = useNavigate();
  const cancel = useMutation({
    mutationFn: () => client.runs.cancel({ id: run.id }),
    onSuccess: async () => {
      showNotification({ color: 'green', message: 'Cancellation requested' });
      await invalidate({ resource: 'runs', invalidates: ['detail', 'list'], id: run.id });
    },
    onError: (e) => notifyError('Could not cancel the run', e),
  });
  const replay = useMutation({
    mutationFn: () => client.runs.replay({ id: run.id }),
    onSuccess: async (next) => {
      showNotification({ color: 'green', message: 'Replay queued' });
      await navigate(`/runs/show/${next.id}`);
    },
    onError: (e) => notifyError('Could not replay the run', e),
  });
  const active = run.status === 'pending' || run.status === 'running';

  return (
    <CanAccess resource="runs" action={active ? 'cancel' : 'replay'}>
      {active ? (
        <Button
          color="red"
          variant="light"
          leftIcon={<IconPlayerStop size={16} />}
          loading={cancel.isPending}
          onClick={() => cancel.mutate()}
        >
          Cancel run
        </Button>
      ) : (
        <Button
          variant="default"
          leftIcon={<IconRepeat size={16} />}
          loading={replay.isPending}
          onClick={() => replay.mutate()}
        >
          Replay
        </Button>
      )}
    </CanAccess>
  );
}

export function RunShow() {
  const { query } = useShow<RunDto>({ resource: 'runs', liveMode: 'auto' });
  const run = query.data?.data;
  const result = run ? lastResult(run) : undefined;

  return (
    <Show
      isLoading={query.isLoading}
      title="Run"
      canEdit={false}
      canDelete={false}
      headerButtons={run ? <RunActions run={run} /> : undefined}
    >
      {run && (
        <Stack spacing="lg">
          <SimpleGrid
            cols={4}
            breakpoints={[{ maxWidth: 'md', cols: 2 }]}
            className="ct-panel"
            p="lg"
          >
            <Stack spacing={2}>
              <Text size="sm" color="dimmed">
                Status
              </Text>
              <div>
                <StatusBadge status={run.status} />
              </div>
            </Stack>
            <Stack spacing={2}>
              <Text size="sm" color="dimmed">
                Job
              </Text>
              <Anchor component={Link} to={`/jobs/show/${run.jobId}`} size="sm">
                {run.jobName}
              </Anchor>
            </Stack>
            <Stack spacing={2}>
              <Text size="sm" color="dimmed">
                Scheduled for
              </Text>
              <Text size="sm">{dateTime(run.scheduledAt)}</Text>
            </Stack>
            <Stack spacing={2}>
              <Text size="sm" color="dimmed">
                Duration
              </Text>
              <Text size="sm">{duration(result?.durationMs)}</Text>
            </Stack>
          </SimpleGrid>
          {run.status === 'skipped' && <Text color="dimmed">Skipped: {run.skipReason}</Text>}
          {run.event && <InboundEvent event={run.event} />}
          {run.status === 'pending' && run.attempts.length > 0 && (
            <Text color="dimmed">Retrying at {dateTime(run.availableAt)}.</Text>
          )}
          <Stack className="ct-panel" p="lg" spacing="md">
            <Text weight={600}>Attempts</Text>
            {run.attempts.length === 0 ? (
              <Text size="sm" color="dimmed">
                {run.status === 'running'
                  ? 'The first attempt is in progress.'
                  : 'No attempts yet.'}
              </Text>
            ) : (
              <Timeline bulletSize={22} lineWidth={2} active={run.attempts.length - 1}>
                {run.attempts.map((a) => {
                  const ok = a.result.outcome === 'success';

                  return (
                    <Timeline.Item
                      key={a.attempt}
                      title={
                        <Group spacing={6}>
                          <Text weight={600} size="sm">
                            Attempt {a.attempt}
                          </Text>
                          <Text size="sm" color="dimmed">
                            {ok ? 'succeeded' : 'failed'}
                          </Text>
                        </Group>
                      }
                      bullet={
                        <span
                          style={{
                            display: 'inline-flex',
                            color: ok ? STATUS.succeeded.color : STATUS.failed.color,
                          }}
                        >
                          {ok ? STATUS.succeeded.icon : STATUS.failed.icon}
                        </span>
                      }
                    >
                      <AttemptDetail attempt={a} />
                    </Timeline.Item>
                  );
                })}
              </Timeline>
            )}
          </Stack>
          <RunNotifications run={run} />
        </Stack>
      )}
    </Show>
  );
}
