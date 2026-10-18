import { Alert, Button, Code, Group, List, SimpleGrid, Stack, Text } from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { CanAccess, useInvalidate, useList, useShow } from '@refinedev/core';
import { DeleteButton, EditButton, Show } from '@refinedev/mantine';
import { IconPlayerPause, IconPlayerPlay, IconPlayerTrackNext } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';

import { BackfillDialog } from '../../components/BackfillDialog';
import { RunsOverTimeChart } from '../../components/charts';
import { ExplainPanel } from '../../components/ExplainPanel';
import { GroupChip } from '../../components/GroupChip';
import { JobDependencies } from '../../components/JobDependencies';
import { RunsTable } from '../../components/RunsTable';
import { BadgeButton } from '../../components/ShareButtons';
import { type JobDto, type RunDto, client } from '../../lib/api';
import { notifyError } from '../../lib/errors';
import { dateTime, duration, fromNow, percent } from '../../lib/format';
import { useGroupsById } from '../../lib/groups';
import { targetSummary } from '../../lib/job-summary';
import { toSpec } from './form';
import { JobState } from './state';

const WEEK = 7 * 86_400_000;

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

function JobActions({ job }: { job: JobDto }) {
  const invalidate = useInvalidate();
  const refresh = () =>
    Promise.all([
      invalidate({ resource: 'jobs', invalidates: ['detail', 'list'], id: job.id }),
      invalidate({ resource: 'runs', invalidates: ['list'] }),
    ]);
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
      <Group spacing="xs">
        <Button
          leftIcon={<IconPlayerTrackNext size={16} />}
          loading={runNow.isPending}
          onClick={() => runNow.mutate()}
        >
          Run now
        </Button>
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
      </Group>
    </CanAccess>
  );
}

function WebhookPanel({ job }: { job: JobDto }) {
  const url = `${window.location.origin}/hooks/${job.id}/<token>`;

  return (
    <Stack className="ct-panel" p="lg" spacing="xs">
      <Text weight={600}>Webhook endpoint</Text>
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

function JobInsights({ job }: { job: JobDto }) {
  const lastWeek = () => ({
    from: new Date(Date.now() - WEEK).toISOString(),
    to: new Date(Date.now() + 60_000).toISOString(),
    jobId: job.id,
  });
  const summary = useQuery({
    queryKey: ['analytics', 'summary', job.id],
    queryFn: () => client.analytics.summary(lastWeek()),
  });
  const series = useQuery({
    queryKey: ['analytics', 'series', job.id],
    queryFn: () => client.analytics.timeseries({ ...lastWeek(), bucket: 'hour' }),
  });
  const preview = useQuery({
    queryKey: ['jobs', 'validate', job.id, job.version],
    queryFn: () => client.jobs.validate(toSpec(job)),
    retry: false,
  });
  const s = summary.data;

  return (
    <Stack spacing="lg">
      <SimpleGrid cols={4} breakpoints={[{ maxWidth: 'md', cols: 2 }]} className="ct-panel" p="lg">
        <Fact label="State">
          <JobState job={job} />
        </Fact>
        <Fact label="Schedule">{preview.data?.description ?? job.trigger.type}</Fact>
        <Fact label="Next run">
          <span title={dateTime(job.schedule.nextFireAt)}>{fromNow(job.schedule.nextFireAt)}</span>
        </Fact>
        <Fact label="Target">
          <Text size="sm" className="ct-mono" lineClamp={1}>
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
      {job.pausedReason !== null && (
        <Alert color="orange" title="Paused">
          {job.pausedReason}. Resume to schedule runs again.
        </Alert>
      )}
      {job.trigger.type === 'webhook' && <WebhookPanel job={job} />}
      {(preview.data?.nextFireTimes.length ?? 0) > 0 && (
        <Stack className="ct-panel" p="lg" spacing="xs">
          <Text weight={600}>Upcoming runs</Text>
          <List size="sm" spacing={2}>
            {preview.data?.nextFireTimes.map((t) => (
              <List.Item key={t}>{dateTime(t)}</List.Item>
            ))}
          </List>
        </Stack>
      )}
      <Stack className="ct-panel" p="lg" spacing="xs">
        <Text weight={600}>Runs by outcome, last 7 days</Text>
        <RunsOverTimeChart points={series.data ?? []} height={220} />
      </Stack>
    </Stack>
  );
}

export function JobShow() {
  const { query } = useShow<JobDto>({ resource: 'jobs' });
  const job = query.data?.data;
  const groups = useGroupsById();
  const group = job?.groupId ? groups.get(job.groupId) : undefined;
  const runs = useList<RunDto>({
    resource: 'runs',
    filters: [{ field: 'jobId', operator: 'eq', value: job?.id }],
    pagination: { pageSize: 25 },
    queryOptions: { enabled: job !== undefined },
  });

  return (
    <Show
      isLoading={query.isLoading}
      title={job?.name ?? 'Job'}
      headerButtons={
        job ? (
          <Group spacing="xs">
            <JobActions job={job} />
            {job.upstreamJobIds.length === 0 && (
              <CanAccess resource="jobs" action="backfill">
                <BackfillDialog job={job} />
              </CanAccess>
            )}
            <BadgeButton job={job} />
            <EditButton recordItemId={job.id} />
            <DeleteButton
              recordItemId={job.id}
              confirmTitle="Delete this job? Its run history stays until retention removes it."
            />
          </Group>
        ) : undefined
      }
    >
      {job && (
        <Stack spacing="lg">
          {(job.description || group) && (
            <Group spacing="sm">
              {group && <GroupChip group={group} />}
              {job.description && <Text color="dimmed">{job.description}</Text>}
            </Group>
          )}
          <JobInsights job={job} />
          <JobDependencies job={job} />
          <ExplainPanel job={job} />
          <Stack className="ct-panel" spacing={0}>
            <Text weight={600} p="lg" pb="xs">
              Recent runs
            </Text>
            <RunsTable runs={runs.result.data} showJob={false} />
          </Stack>
        </Stack>
      )}
    </Show>
  );
}
