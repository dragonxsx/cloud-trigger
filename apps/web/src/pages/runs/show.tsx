import { FanoutMetadata } from '@cloud-trigger/core';
import {
  ActionIcon,
  Anchor,
  Badge,
  Breadcrumbs,
  Button,
  Code,
  CopyButton,
  Group,
  ScrollArea,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  Timeline,
  Tooltip,
} from '@mantine/core';
import {
  CanAccess,
  useInvalidate,
  useNavigation,
  useNotification,
  useOne,
  useShow,
} from '@refinedev/core';
import { Show } from '@refinedev/mantine';
import { IconCheck, IconCopy, IconPlayerStop, IconRepeat } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { confirmAction } from '../../components/confirm';
import { PageHeading, backIcon } from '../../components/page-chrome';
import { RecordLoadError } from '../../components/PageState';
import { RunNotifications } from '../../components/RunNotifications';
import { REASON_LABEL, errorCodeText, errorText, lastResult } from '../../components/RunsTable';
import { usePageTitle } from '../../components/usePageTitle';
import { type JobDto, type RunDto, client } from '../../lib/api';
import { notifyError } from '../../lib/errors';
import { dateTime, duration } from '../../lib/format';
import { targetSummary } from '../../lib/job-summary';
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

function CopyIcon({ value, label }: { value: string; label: string }) {
  return (
    <CopyButton value={value} timeout={1500}>
      {(clipboard) => (
        <Tooltip label={clipboard.copied ? 'Copied' : label} withArrow>
          <ActionIcon
            variant="subtle"
            color={clipboard.copied ? 'teal' : 'gray'}
            onClick={() => clipboard.copy()}
            aria-label={label}
          >
            {clipboard.copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
          </ActionIcon>
        </Tooltip>
      )}
    </CopyButton>
  );
}

function CodeBlock({ value, copyLabel }: { value: string; copyLabel: string }) {
  return (
    <div style={{ position: 'relative' }}>
      <Code
        block
        tabIndex={0}
        style={{
          maxHeight: 420,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          paddingRight: 44,
        }}
      >
        {value}
      </Code>
      <div style={{ position: 'absolute', top: 6, right: 6 }}>
        <CopyIcon value={value} label={copyLabel} />
      </div>
    </div>
  );
}

function FanoutChildren({ metadata }: { metadata: FanoutMetadata }) {
  return (
    <ScrollArea>
      <Table fontSize="sm" verticalSpacing={4} miw={520}>
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
                    <b className="ct-mono">{child.error.code}</b> {errorText(child.error)}
                  </>
                ) : child.statusCode !== undefined ? (
                  `HTTP ${child.statusCode}`
                ) : (
                  ''
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </ScrollArea>
  );
}

function AttemptDetail({ attempt, target }: { attempt: Attempt; target: string | undefined }) {
  const { result } = attempt;
  const fanout = FanoutMetadata.safeParse(result.metadata);
  const hasMetadata = result.metadata !== undefined && Object.keys(result.metadata).length > 0;
  const call =
    target === undefined
      ? undefined
      : `${target}${result.statusCode === undefined ? '' : ` → ${result.statusCode}`}`;

  return (
    <Stack spacing="xs">
      {call !== undefined && (
        <Text size="sm" className="ct-mono" sx={{ wordBreak: 'break-all' }}>
          {call}
        </Text>
      )}
      <Text size="sm" color="dimmed">
        {dateTime(attempt.startedAt)} · {duration(result.durationMs)} · worker {attempt.workerId}
        {call === undefined && result.statusCode !== undefined && ` · HTTP ${result.statusCode}`}
      </Text>
      {result.error && (
        <Text size="sm">
          <b className="ct-mono">{result.error.code}</b>{' '}
          {result.error.message.trim() === ''
            ? errorCodeText(result.error.code)
            : result.error.message}
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
        <CodeBlock value={JSON.stringify(result.metadata, null, 2)} copyLabel="Copy metadata" />
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
            <CodeBlock value={prettyBody(result.response.body)} copyLabel="Copy response body" />
          </Tabs.Panel>
          <Tabs.Panel value="headers" pt="xs">
            <CodeBlock
              value={JSON.stringify(result.response.headers ?? {}, null, 2)}
              copyLabel="Copy response headers"
            />
          </Tabs.Panel>
          <Tabs.Panel value="metadata" pt="xs">
            <CodeBlock
              value={JSON.stringify(result.metadata ?? {}, null, 2)}
              copyLabel="Copy metadata"
            />
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
          <CodeBlock value={prettyBody(event.body)} copyLabel="Copy event body" />
        </Tabs.Panel>
        <Tabs.Panel value="headers" pt="xs">
          <CodeBlock
            value={JSON.stringify(event.headers, null, 2)}
            copyLabel="Copy event headers"
          />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

function RunActions({ run }: { run: RunDto }) {
  const invalidate = useInvalidate();
  const { show } = useNavigation();
  const { open } = useNotification();
  const cancel = useMutation({
    mutationFn: () => client.runs.cancel({ id: run.id }),
    onSuccess: async () => {
      open?.({ type: 'success', message: 'Cancellation requested' });
      await invalidate({ resource: 'runs', invalidates: ['detail', 'list'], id: run.id });
    },
    onError: (e) => notifyError('Could not cancel the run', e),
  });
  const replay = useMutation({
    mutationFn: () => client.runs.replay({ id: run.id }),
    onSuccess: (next) => {
      open?.({ type: 'success', message: 'Replay queued' });
      show('runs', next.id);
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
          onClick={() => {
            void confirmAction({
              title: `Cancel this run of ${run.jobName}?`,
              message:
                run.status === 'running'
                  ? 'The worker stops the call in progress on its next heartbeat. No more attempts are made.'
                  : 'The run will not start, and no more attempts are made.',
              confirmLabel: 'Cancel run',
              cancelLabel: 'Keep running',
              onConfirm: () => cancel.mutate(),
            });
          }}
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

function RunHeaderButtons({ run }: { run: RunDto | undefined }) {
  return run ? <RunActions run={run} /> : null;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack spacing={2} sx={{ minWidth: 0 }}>
      <Text size="sm" color="dimmed">
        {label}
      </Text>
      {children}
    </Stack>
  );
}

const startedAt = (run: RunDto): string | undefined =>
  run.attempts[0]?.startedAt ?? (run.status === 'running' ? run.startedAt : undefined);

const finishedAt = (run: RunDto): string | undefined =>
  run.status === 'pending' || run.status === 'running' ? undefined : run.finishedAt;

const runTitle = (run: RunDto): string => `${run.jobName} · ${dateTime(run.scheduledAt)}`;

export function RunShow() {
  const { listUrl, showUrl } = useNavigation();
  const { query } = useShow<RunDto>({
    resource: 'runs',
    liveMode: 'auto',
    errorNotification: false,
  });
  const run = query.data?.data;
  const result = run ? lastResult(run) : undefined;
  const job = useOne<JobDto>({
    resource: 'jobs',
    id: run?.jobId ?? '',
    queryOptions: { enabled: run !== undefined, retry: false },
    errorNotification: false,
  });
  const target = job.result ? targetSummary(job.result) : undefined;
  usePageTitle(run ? `${run.jobName} run` : undefined, 'Runs');

  if (query.isError) {
    return (
      <RecordLoadError
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
        resource="Run"
        listPath="/runs"
        listLabel="Runs"
      />
    );
  }

  return (
    <Show
      isLoading={query.isLoading}
      goBack={backIcon}
      title={<PageHeading>{run ? runTitle(run) : 'Run'}</PageHeading>}
      canEdit={false}
      canDelete={false}
      headerButtons={<RunHeaderButtons run={run} />}
      breadcrumb={
        <Breadcrumbs>
          <Anchor component={Link} to={listUrl('runs')} size="sm">
            Runs
          </Anchor>
          <Text size="sm" color="dimmed">
            {run ? runTitle(run) : 'Run'}
          </Text>
        </Breadcrumbs>
      }
    >
      {run && (
        <Stack spacing="lg">
          <Stack className="ct-panel" p="lg" spacing="md">
            <SimpleGrid
              cols={4}
              breakpoints={[
                { maxWidth: 'md', cols: 2 },
                { maxWidth: 'xs', cols: 1 },
              ]}
            >
              <Fact label="Status">
                <Group spacing={4}>
                  <StatusBadge status={run.status} />
                  {run.late && (
                    <Badge color="orange" variant="light" radius="sm" tt="none">
                      Late
                    </Badge>
                  )}
                </Group>
              </Fact>
              <Fact label="Job">
                <Anchor component={Link} to={showUrl('jobs', run.jobId)} size="sm">
                  {run.jobName}
                </Anchor>
              </Fact>
              <Fact label="Reason">
                <div>
                  <Badge color="gray" variant="outline" radius="sm" tt="none">
                    {REASON_LABEL[run.reason]}
                  </Badge>
                </div>
              </Fact>
              <Fact label="Run ID">
                <Group spacing={4} noWrap>
                  <Text size="sm" className="ct-mono" truncate title={run.id}>
                    {run.id}
                  </Text>
                  <CopyIcon value={run.id} label="Copy run ID" />
                </Group>
              </Fact>
              <Fact label="Scheduled for">
                <Text size="sm">{dateTime(run.scheduledAt)}</Text>
              </Fact>
              <Fact label="Started">
                <Text size="sm">{dateTime(startedAt(run))}</Text>
              </Fact>
              <Fact label="Finished">
                <Text size="sm">{dateTime(finishedAt(run))}</Text>
              </Fact>
              <Fact label="Duration">
                <Text size="sm">{duration(result?.durationMs)}</Text>
              </Fact>
            </SimpleGrid>
            {target !== undefined && (
              <Fact label="Endpoint (from the job's current configuration)">
                <Text size="sm" className="ct-mono" sx={{ wordBreak: 'break-all' }}>
                  {target}
                </Text>
              </Fact>
            )}
            {run.late && run.lateReasons.length > 0 && (
              <Text size="sm" color="dimmed">
                Late: {run.lateReasons.join('; ')}
              </Text>
            )}
          </Stack>
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
                      <AttemptDetail attempt={a} target={target} />
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
