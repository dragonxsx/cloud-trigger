import {
  Alert,
  Badge,
  Box,
  Button,
  Code,
  Group,
  List,
  Menu,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { CanAccess, useDelete, useInvalidate, useList, useShow } from '@refinedev/core';
import { EditButton, Show } from '@refinedev/mantine';
import {
  IconDots,
  IconHistory,
  IconPhoto,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerTrackNext,
  IconPlugConnected,
  IconPower,
  IconTrash,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Suspense, lazy, useState } from 'react';
import { useNavigate } from 'react-router';

import { BackfillDialog } from '../../components/BackfillDialog';
import { confirmAction } from '../../components/confirm';
import { ExplainPanel } from '../../components/ExplainPanel';
import {
  ExtractConnectionDialog,
  useExtractableSlots,
} from '../../components/ExtractConnectionDialog';
import { GroupChip } from '../../components/GroupChip';
import { JobDependencies } from '../../components/JobDependencies';
import { backIcon, pageBreadcrumb } from '../../components/page-chrome';
import { RecordLoadError } from '../../components/PageState';
import { RunsTable } from '../../components/RunsTable';
import { copyWithFallback } from '../../components/ShareButtons';
import { useLiveAnalyticsRefresh } from '../../components/useLiveAnalyticsRefresh';
import { usePageTitle } from '../../components/usePageTitle';
import { type JobDto, type RunDto, client } from '../../lib/api';
import { notifyError } from '../../lib/errors';
import { dateTime, dateTimeWithLocal, duration, fromNow, percent } from '../../lib/format';
import { useGroupsById } from '../../lib/groups';
import { targetSummary, triggerSummary } from '../../lib/job-summary';
import { toSpec, triggerZone } from './form';
import { DISABLED_HINT, JobState, isHalted } from './state';

const LIVE_ANALYTICS_MS = 5_000;

const WEEK = 7 * 86_400_000;
const HOUR_MS = 3_600_000;

const RunsOverTimeChart = lazy(async () => ({
  default: (await import('../../components/charts')).RunsOverTimeChart,
}));

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Stack spacing={2}>
      <Text size="sm" color="dimmed">
        {label}
      </Text>
      <Text size="sm" weight={500} component="div">
        {children}
      </Text>
    </Stack>
  );
}

function PanelTitle({ children }: { children: React.ReactNode }) {
  return (
    <Title order={2} size="h5">
      {children}
    </Title>
  );
}

function useJobRefresh(job: JobDto) {
  const invalidate = useInvalidate();
  const queryClient = useQueryClient();

  return () =>
    Promise.all([
      invalidate({ resource: 'jobs', invalidates: ['detail', 'list'], id: job.id }),
      invalidate({ resource: 'runs', invalidates: ['list'] }),
      queryClient.invalidateQueries({ queryKey: ['analytics'] }),
      queryClient.invalidateQueries({ queryKey: ['jobs', job.id] }),
    ]);
}

function JobActions({ job }: { job: JobDto }) {
  const refresh = useJobRefresh(job);
  const runNow = useMutation({
    mutationFn: () => client.jobs.run({ id: job.id }),
    onSuccess: async () => {
      showNotification({ color: 'green', message: 'Run queued' });
      await refresh();
    },
    onError: (e) => notifyError('Could not start the run', e),
  });
  const toggle = useMutation({
    mutationFn: () =>
      job.pausedReason === null
        ? client.jobs.pause({ id: job.id })
        : client.jobs.resume({ id: job.id }),
    onSuccess: async (updated) => {
      showNotification({
        color: 'green',
        message: updated.pausedReason === null ? 'Job resumed' : 'Job paused',
      });
      await refresh();
    },
    onError: (e) => notifyError('Could not update the job', e),
  });

  return (
    <CanAccess resource="jobs" action="run">
      <Button
        leftIcon={<IconPlayerTrackNext size={16} />}
        loading={runNow.isPending}
        onClick={() => runNow.mutate()}
      >
        Run now
      </Button>
      {job.enabled && (
        <Button
          variant="default"
          leftIcon={
            job.pausedReason === null ? <IconPlayerPause size={16} /> : <IconPlayerPlay size={16} />
          }
          loading={toggle.isPending}
          onClick={() => toggle.mutate()}
        >
          {job.pausedReason === null ? 'Pause' : 'Resume'}
        </Button>
      )}
    </CanAccess>
  );
}

function EnableButton({ job }: { job: JobDto }) {
  const refresh = useJobRefresh(job);
  const enable = useMutation({
    mutationFn: () =>
      client.jobs.update({
        ...toSpec(job),
        enabled: true,
        id: job.id,
        expectedVersion: job.version,
      }),
    onSuccess: async () => {
      showNotification({ color: 'green', message: 'Job enabled' });
      await refresh();
    },
    onError: (e) => notifyError('Could not enable the job', e),
  });

  return (
    <CanAccess resource="jobs" action="edit">
      <Button
        size="xs"
        color="gray"
        variant="default"
        leftIcon={<IconPower size={14} />}
        loading={enable.isPending}
        onClick={() => enable.mutate()}
      >
        Enable job
      </Button>
    </CanAccess>
  );
}

function MoreActions({ job }: { job: JobDto }) {
  const [dialog, setDialog] = useState<'backfill' | 'extract' | null>(null);
  const close = () => setDialog(null);
  const slots = useExtractableSlots(job);
  const navigate = useNavigate();
  const { mutate: remove } = useDelete<JobDto>();
  const canBackfill = job.upstreamJobIds.length === 0;
  const canExtract = job.workflowId === null && slots.length > 0;
  const copyBadge = () => {
    const url = `${window.location.origin}/badges/jobs/${job.id}.svg`;
    void copyWithFallback({
      value: `![${job.name}](${url})`,
      copiedTitle: 'Badge Markdown copied',
      fallbackTitle: 'Status badge Markdown',
      note: 'Paste it into a README. Viewers outside Cloud Trigger only see the badge when the server runs with BADGES_PUBLIC=true.',
    });
  };
  const deleteJob = () =>
    void confirmAction({
      title: `Delete ${job.name}?`,
      message: 'The job stops running. Its run history stays until retention removes it.',
      confirmLabel: 'Delete job',
      onConfirm: () =>
        remove(
          { resource: 'jobs', id: job.id, mutationMode: 'pessimistic' },
          { onSuccess: () => void navigate('/jobs') },
        ),
    });

  return (
    <>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <Button variant="default" rightIcon={<IconDots size={16} />}>
            More
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          {canBackfill && (
            <CanAccess resource="jobs" action="backfill">
              <Menu.Item icon={<IconHistory size={16} />} onClick={() => setDialog('backfill')}>
                Backfill past runs…
              </Menu.Item>
            </CanAccess>
          )}
          {canExtract && (
            <CanAccess resource="jobs" action="extract">
              <Menu.Item
                icon={<IconPlugConnected size={16} />}
                onClick={() => setDialog('extract')}
              >
                Extract connection…
              </Menu.Item>
            </CanAccess>
          )}
          <Menu.Item icon={<IconPhoto size={16} />} onClick={copyBadge}>
            Copy status badge Markdown
          </Menu.Item>
          <CanAccess resource="jobs" action="delete">
            <Menu.Divider />
            <Menu.Item color="red" icon={<IconTrash size={16} />} onClick={deleteJob}>
              Delete job…
            </Menu.Item>
          </CanAccess>
        </Menu.Dropdown>
      </Menu>
      {canBackfill && <BackfillDialog job={job} opened={dialog === 'backfill'} onClose={close} />}
      {canExtract && (
        <ExtractConnectionDialog job={job} opened={dialog === 'extract'} onClose={close} />
      )}
    </>
  );
}

function WebhookPanel({ job }: { job: JobDto }) {
  const url = `${window.location.origin}/hooks/${job.id}/<token>`;

  return (
    <Stack className="ct-panel" p="lg" spacing="xs">
      <PanelTitle>Webhook endpoint</PanelTitle>
      <Text size="sm" color="dimmed">
        POST to this address to start a run. Replace &lt;token&gt; with the token from the trigger
        settings; it is never shown again here. Send an Idempotency-Key header to make retries safe.
      </Text>
      <Code block className="ct-mono">
        {`curl -X POST '${url}' \\\n  -H 'content-type: application/json' \\\n  -H 'idempotency-key: <unique id>' \\\n  -d '{"hello":"world"}'`}
      </Code>
    </Stack>
  );
}

const lastWeek = (jobId: string) => ({
  from: new Date(Date.now() - WEEK).toISOString(),
  to: new Date(Date.now() + 60_000).toISOString(),
  jobId,
});

function useSchedulePreview(job: JobDto) {
  return useQuery({
    queryKey: ['jobs', 'validate', job.id, job.version],
    queryFn: () => client.jobs.validate(toSpec(job)),
    retry: false,
  });
}

function NextRun({ job }: { job: JobDto }) {
  if (isHalted(job)) {
    return (
      <Text size="sm" color="dimmed" component="span">
        — ({job.enabled ? 'paused' : 'disabled'})
      </Text>
    );
  }

  return (
    <Tooltip
      label={dateTime(job.schedule.nextFireAt)}
      disabled={job.schedule.nextFireAt === null}
      withArrow
    >
      <span>{fromNow(job.schedule.nextFireAt)}</span>
    </Tooltip>
  );
}

function JobOverview({ job, description }: { job: JobDto; description: string | undefined }) {
  const summary = useQuery({
    queryKey: ['analytics', 'summary', job.id],
    queryFn: () => client.analytics.summary(lastWeek(job.id)),
  });
  const s = summary.data;

  return (
    <Stack spacing="lg">
      <SimpleGrid cols={4} breakpoints={[{ maxWidth: 'md', cols: 2 }]} className="ct-panel" p="lg">
        <Fact label="State">
          <JobState job={job} />
        </Fact>
        <Fact label="Schedule">
          {description === undefined || job.trigger.type === 'manual'
            ? triggerSummary(job)
            : description}
        </Fact>
        <Fact label="Next run">
          <NextRun job={job} />
        </Fact>
        <Fact label="Target">
          <Text size="sm" className="ct-mono" lineClamp={2} sx={{ overflowWrap: 'anywhere' }}>
            {targetSummary(job)}
          </Text>
        </Fact>
        <Fact label="Runs, last 7 days">{s ? s.total.toLocaleString() : '—'}</Fact>
        <Fact label="Success rate">{percent(s?.successRate ?? null)}</Fact>
        <Fact label="p95 latency">{duration(s?.p95Ms)}</Fact>
        <Fact label="Last success">{fromNow(job.schedule.lastSuccessAt)}</Fact>
      </SimpleGrid>
      {job.slaBreachedAt !== null && (
        <Alert color="gray" variant="outline" title="Breaching its SLA">
          No run has succeeded within the job&apos;s since-last-success window (flagged{' '}
          {dateTime(job.slaBreachedAt)}). The next successful run clears this.
        </Alert>
      )}
      {!job.enabled && (
        <Alert color="gray" title="Disabled">
          <Stack spacing="xs">
            <Text size="sm">{DISABLED_HINT}</Text>
            <Group>
              <EnableButton job={job} />
            </Group>
          </Stack>
        </Alert>
      )}
    </Stack>
  );
}

function UpcomingRuns({ job, times }: { job: JobDto; times: readonly string[] }) {
  const halted = isHalted(job);
  const zone = triggerZone(job.trigger);

  return (
    <Stack className="ct-panel" p="lg" spacing="xs">
      <PanelTitle>
        {halted
          ? job.enabled
            ? 'Would run at, after resume'
            : 'Would run at, once enabled'
          : 'Upcoming runs'}
      </PanelTitle>
      <Box sx={{ opacity: halted ? 0.6 : 1 }}>
        <List size="sm" spacing={2}>
          {times.map((t) => (
            <List.Item key={t}>
              {zone === undefined ? dateTime(t) : dateTimeWithLocal(t, zone)}
            </List.Item>
          ))}
        </List>
      </Box>
    </Stack>
  );
}

function RunsChart({ job }: { job: JobDto }) {
  const series = useQuery({
    queryKey: ['analytics', 'series', job.id],
    queryFn: () => client.analytics.timeseries({ ...lastWeek(job.id), bucket: 'hour' }),
  });
  const points = series.data ?? [];

  return (
    <Stack className="ct-panel" p="lg" spacing="xs">
      <PanelTitle>Runs by outcome, last 7 days</PanelTitle>
      {series.isSuccess && points.length === 0 ? (
        <Text size="sm" color="dimmed" py="xl" align="center">
          No runs in the last 7 days.
        </Text>
      ) : (
        <Suspense fallback={<Skeleton height={220} radius="sm" />}>
          <RunsOverTimeChart
            points={points}
            height={220}
            loading={series.isLoading}
            bucketMs={HOUR_MS}
          />
        </Suspense>
      )}
    </Stack>
  );
}

const recentRunsEmpty = (job: JobDto): string => {
  if (job.workflowId !== null && job.trigger.type === 'manual') {
    return 'No runs yet. This job runs as a step of its workflow, or use Run now.';
  }
  if (job.schedule.nextFireAt === null) {
    return 'No runs yet. Use Run now to start one.';
  }

  return 'No runs yet. Use Run now, or wait for the next scheduled run.';
};

function RecentRuns({ job }: { job: JobDto }) {
  const runs = useList<RunDto>({
    resource: 'runs',
    filters: [{ field: 'jobId', operator: 'eq', value: job.id }],
    pagination: { pageSize: 25 },
  });
  const items = runs.result.data;

  return (
    <Stack className="ct-panel" spacing={0}>
      <Box p="lg" pb="xs">
        <PanelTitle>Recent runs</PanelTitle>
      </Box>
      <RunsTable
        runs={items}
        showJob={false}
        loading={runs.query.isLoading}
        empty={recentRunsEmpty(job)}
      />
    </Stack>
  );
}

function JobDetails({ job }: { job: JobDto }) {
  const groups = useGroupsById();
  const group = job.groupId ? groups.get(job.groupId) : undefined;
  const environment = job.environment ?? group?.environment ?? null;
  const preview = useSchedulePreview(job);
  const times = preview.data?.nextFireTimes ?? [];

  return (
    <Stack spacing="lg">
      {(job.description || group || environment) && (
        <Group spacing="sm">
          {group && <GroupChip group={group} />}
          {environment && (
            <Badge variant="light" color="gray" tt="none">
              {job.environment ? environment : `${environment} (from group)`}
            </Badge>
          )}
          {job.description && <Text color="dimmed">{job.description}</Text>}
        </Group>
      )}
      <JobOverview job={job} description={preview.data?.description} />
      <RecentRuns job={job} />
      <SimpleGrid
        cols={times.length > 0 ? 2 : 1}
        spacing="lg"
        breakpoints={[{ maxWidth: 'md', cols: 1 }]}
      >
        {times.length > 0 && <UpcomingRuns job={job} times={times} />}
        <RunsChart job={job} />
      </SimpleGrid>
      {job.trigger.type === 'webhook' && <WebhookPanel job={job} />}
      <JobDependencies job={job} />
      <ExplainPanel job={job} />
    </Stack>
  );
}

function JobHeaderButtons({ job }: { job: JobDto | undefined }) {
  if (!job) {
    return null;
  }

  return (
    <Group spacing="xs">
      <JobActions job={job} />
      <EditButton recordItemId={job.id} variant="default" />
      <MoreActions job={job} />
    </Group>
  );
}

export function JobShow() {
  const { query } = useShow<JobDto>({ resource: 'jobs', errorNotification: false });
  const job = query.data?.data;
  usePageTitle(job?.name, 'Jobs');
  useLiveAnalyticsRefresh(LIVE_ANALYTICS_MS);

  if (query.isError) {
    return (
      <RecordLoadError
        error={query.error}
        onRetry={() => void query.refetch()}
        resource="Job"
        listPath="/jobs"
        listLabel="Jobs"
      />
    );
  }

  return (
    <Show
      isLoading={query.isLoading}
      goBack={backIcon}
      breadcrumb={pageBreadcrumb}
      title={
        <Title order={1} size="h3" sx={{ overflowWrap: 'anywhere' }}>
          {job?.name ?? 'Job'}
        </Title>
      }
      headerButtons={<JobHeaderButtons job={job} />}
    >
      {job && <JobDetails job={job} />}
    </Show>
  );
}
