import {
  ActionIcon,
  Anchor,
  Group,
  SegmentedControl,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { useList } from '@refinedev/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { type ReactNode, Suspense, lazy, useMemo, useState } from 'react';
import { Link } from 'react-router';

import { NextFire, useNow } from '../components/NextFire';
import { LoadError } from '../components/PageState';
import { errorCodeText } from '../components/RunsTable';
import { useLiveAnalyticsRefresh } from '../components/useLiveAnalyticsRefresh';
import { type JobDto, client } from '../lib/api';
import { duration, percent } from '../lib/format';
import { STATUS } from '../lib/status';

const RunsOverTimeChart = lazy(async () => ({
  default: (await import('../components/charts')).RunsOverTimeChart,
}));
const LatencyChart = lazy(async () => ({
  default: (await import('../components/charts')).LatencyChart,
}));

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const RANGES = {
  '24h': { ms: DAY_MS, bucket: 'hour', bucketMs: HOUR_MS },
  '7d': { ms: 7 * DAY_MS, bucket: 'hour', bucketMs: HOUR_MS },
  '30d': { ms: 30 * DAY_MS, bucket: 'day', bucketMs: DAY_MS },
} as const;
type RangeKey = keyof typeof RANGES;
const isRange = (v: string): v is RangeKey => v in RANGES;

const REFRESH_MS = 60_000;
const LIVE_REFRESH_MS = 15_000;
const NEXT_UP = 8;
const FAILED_INBOX_PATH = '/runs?view=failed';
const SUCCESS_RATE_HINT =
  'Success rate is succeeded ÷ (succeeded + failed + timed out). Skipped and cancelled runs are not counted.';

const windowFor = (range: RangeKey) => {
  const to = Date.now() + 60_000;

  return { from: new Date(to - RANGES[range].ms).toISOString(), to: new Date(to).toISOString() };
};

const failedRunsOf = (jobId: string): string => {
  const params = new URLSearchParams();
  params.set('filters[0][field]', 'jobId');
  params.set('filters[0][operator]', 'eq');
  params.set('filters[0][value]', jobId);
  params.set('filters[1][field]', 'status');
  params.set('filters[1][operator]', 'in');
  params.set('filters[1][value][0]', 'failed');
  params.set('filters[1][value][1]', 'timed_out');

  return `/runs?${params.toString()}`;
};

function Stat({
  label,
  value,
  hint,
  loading,
}: {
  label: string;
  value: string;
  hint?: ReactNode;
  loading: boolean;
}) {
  return (
    <Stack spacing={2}>
      <Text size="sm" color="dimmed">
        {label}
      </Text>
      {loading ? (
        <Skeleton height={33} width={96} radius="sm" />
      ) : (
        <Text size={30} weight={650} lh={1.1} style={{ letterSpacing: '-0.02em' }}>
          {value}
        </Text>
      )}
      {hint !== undefined && !loading && (
        <Text size="xs" color="dimmed" component="div">
          {hint}
        </Text>
      )}
    </Stack>
  );
}

function SkeletonRows({ rows, columns }: { rows: number; columns: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_row, row) => (
        <tr key={row}>
          {Array.from({ length: columns }, (_cell, column) => (
            <td key={column}>
              <Skeleton height={14} radius="sm" width={column === 0 ? '60%' : '40%'} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

const ChartSkeleton = ({ height }: { height: number }) => <Skeleton height={height} radius="sm" />;

export function Dashboard() {
  const [range, setRange] = useState<RangeKey>('24h');
  const now = useNow();
  useLiveAnalyticsRefresh(LIVE_REFRESH_MS);

  const summary = useQuery({
    queryKey: ['analytics', 'summary', range],
    queryFn: () => client.analytics.summary(windowFor(range)),
    refetchInterval: REFRESH_MS,
    placeholderData: keepPreviousData,
  });
  const series = useQuery({
    queryKey: ['analytics', 'timeseries', range],
    queryFn: async () => {
      const span = windowFor(range);
      const points = await client.analytics.timeseries({ ...span, bucket: RANGES[range].bucket });

      return { span, points };
    },
    refetchInterval: REFRESH_MS,
    placeholderData: keepPreviousData,
  });
  const errors = useQuery({
    queryKey: ['analytics', 'errors', range],
    queryFn: () => client.analytics.topErrors({ ...windowFor(range), limit: 8 }),
    refetchInterval: REFRESH_MS,
    placeholderData: keepPreviousData,
  });
  const jobs = useList<JobDto>({ resource: 'jobs', pagination: { mode: 'off' }, liveMode: 'auto' });

  const jobsLoading = jobs.query.isLoading;
  const jobList = jobs.result.data;
  const jobName = useMemo(() => new Map(jobList.map((j) => [j.id, j.name])), [jobList]);
  const upcoming = useMemo(
    () =>
      jobList
        .filter((j) => j.enabled && j.pausedReason === null && j.schedule.nextFireAt !== null)
        .toSorted((a, b) =>
          (a.schedule.nextFireAt ?? '').localeCompare(b.schedule.nextFireAt ?? ''),
        )
        .slice(0, NEXT_UP),
    [jobList],
  );
  const s = summary.data;
  const statusCount = (status: keyof NonNullable<typeof s>['byStatus']): number =>
    s?.byStatus[status] ?? 0;
  const succeeded = statusCount('succeeded');
  const failures = statusCount('failed') + statusCount('timed_out');
  const finished = succeeded + failures;
  const notCounted = statusCount('skipped') + statusCount('cancelled');
  const summaryLoading = summary.isLoading;
  const bucketMs = RANGES[range].bucketMs;

  return (
    <Stack spacing="lg" maw={1280}>
      <Group position="apart" align="flex-end">
        <Title order={1} size="h2">
          Dashboard
        </Title>
        <SegmentedControl
          role="radiogroup"
          aria-label="Time range"
          value={range}
          onChange={(v) => isRange(v) && setRange(v)}
          data={[
            { value: '24h', label: 'Last 24 hours' },
            { value: '7d', label: '7 days' },
            { value: '30d', label: '30 days' },
          ]}
        />
      </Group>

      {summary.isError && (
        <LoadError
          error={summary.error}
          what="run totals"
          onRetry={() => {
            void summary.refetch();
          }}
        />
      )}

      <SimpleGrid
        cols={4}
        spacing="xl"
        breakpoints={[{ maxWidth: 'md', cols: 2 }]}
        className="ct-panel"
        p="lg"
        aria-busy={summaryLoading}
      >
        <Stat
          label="Runs"
          loading={summaryLoading}
          value={s ? s.total.toLocaleString() : '—'}
          hint={
            s && failures > 0 ? (
              <Anchor component={Link} to={FAILED_INBOX_PATH} size="xs">
                {failures.toLocaleString()} failed or timed out
              </Anchor>
            ) : (
              'No failures'
            )
          }
        />
        <Stat
          label="Success rate"
          loading={summaryLoading}
          value={percent(s?.successRate ?? null)}
          hint={
            <Group spacing={4} noWrap>
              <span>
                {succeeded.toLocaleString()} of {finished.toLocaleString()} finished
                {notCounted > 0 && ` · ${notCounted.toLocaleString()} skipped or cancelled`}
              </span>
              <Tooltip
                label={SUCCESS_RATE_HINT}
                multiline
                width={260}
                withArrow
                events={{ hover: true, focus: true, touch: true }}
              >
                <ActionIcon
                  size="xs"
                  variant="transparent"
                  color="gray"
                  aria-label={SUCCESS_RATE_HINT}
                >
                  <IconInfoCircle size={14} />
                </ActionIcon>
              </Tooltip>
            </Group>
          }
        />
        <Stat
          label="Latency (median)"
          loading={summaryLoading}
          value={duration(s?.p50Ms)}
          hint={`p95 ${duration(s?.p95Ms)}`}
        />
        <Stat
          label="Late"
          loading={summaryLoading}
          value={s ? s.late.toLocaleString() : '—'}
          hint={
            s && s.total > 0 ? `${percent(s.late / s.total)} of runs broke an SLA` : 'SLA breaches'
          }
        />
      </SimpleGrid>

      <Stack className="ct-panel" p="lg" spacing="xs">
        <Text weight={600}>Runs by outcome</Text>
        {series.isError && !series.data ? (
          <LoadError
            error={series.error}
            what="the chart"
            onRetry={() => {
              void series.refetch();
            }}
          />
        ) : series.data ? (
          <Suspense fallback={<ChartSkeleton height={280} />}>
            <RunsOverTimeChart
              points={series.data.points}
              height={280}
              pinnedWindow={series.data.span}
              loading={series.isPlaceholderData}
            />
          </Suspense>
        ) : (
          <ChartSkeleton height={280} />
        )}
      </Stack>

      <SimpleGrid cols={2} spacing="lg" breakpoints={[{ maxWidth: 'lg', cols: 1 }]}>
        <Stack className="ct-panel" p="lg" spacing="xs">
          <Text weight={600}>p95 latency</Text>
          {series.isError && !series.data ? (
            <LoadError
              error={series.error}
              what="the chart"
              onRetry={() => {
                void series.refetch();
              }}
            />
          ) : series.data ? (
            <Suspense fallback={<ChartSkeleton height={220} />}>
              <LatencyChart
                points={series.data.points}
                height={220}
                pinnedWindow={series.data.span}
                bucketMs={bucketMs}
                loading={series.isPlaceholderData}
              />
            </Suspense>
          ) : (
            <ChartSkeleton height={220} />
          )}
        </Stack>
        <Stack className="ct-panel" p="lg" spacing="xs">
          <Text weight={600}>Next up</Text>
          {jobs.query.isError ? (
            <LoadError
              error={jobs.query.error}
              what="jobs"
              onRetry={() => {
                void jobs.query.refetch();
              }}
            />
          ) : !jobsLoading && upcoming.length === 0 ? (
            <Text color="dimmed" size="sm">
              Nothing is scheduled.{' '}
              <Anchor component={Link} to="/jobs/create" size="sm">
                Create a job
              </Anchor>{' '}
              or resume a paused one.
            </Text>
          ) : (
            <Table verticalSpacing={6} aria-busy={jobsLoading}>
              <tbody>
                {jobsLoading ? (
                  <SkeletonRows rows={4} columns={2} />
                ) : (
                  upcoming.map((j) => (
                    <tr key={j.id}>
                      <td>
                        <Anchor component={Link} to={`/jobs/show/${j.id}`} size="sm">
                          {j.name}
                        </Anchor>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {j.schedule.nextFireAt !== null && (
                          <NextFire at={j.schedule.nextFireAt} now={now} dimmed />
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </Table>
          )}
        </Stack>
      </SimpleGrid>

      <Stack className="ct-panel" p="lg" spacing="xs">
        <Text weight={600}>Most frequent errors</Text>
        {errors.isError && !errors.data ? (
          <LoadError
            error={errors.error}
            what="errors"
            onRetry={() => {
              void errors.refetch();
            }}
          />
        ) : errors.data?.length === 0 ? (
          <Text color="dimmed" size="sm">
            No errors in this period.
          </Text>
        ) : (
          <Table
            verticalSpacing={6}
            className="ct-table"
            aria-busy={errors.isLoading || jobsLoading}
          >
            <thead>
              <tr>
                <th>Error</th>
                <th>Job</th>
                <th style={{ textAlign: 'right' }}>Runs</th>
              </tr>
            </thead>
            <tbody>
              {errors.data === undefined ? (
                <SkeletonRows rows={3} columns={3} />
              ) : (
                errors.data.map((e) => {
                  const plain = errorCodeText(e.errorCode);
                  const name = jobName.get(e.jobId);

                  return (
                    <tr key={`${e.jobId}:${e.errorCode}`}>
                      <td>
                        <Group spacing={6} noWrap align="flex-start">
                          <span
                            style={{
                              color: STATUS.failed.color,
                              display: 'inline-flex',
                              marginTop: 3,
                            }}
                            aria-hidden
                          >
                            {STATUS.failed.icon}
                          </span>
                          <Stack spacing={0} sx={{ minWidth: 0 }}>
                            <Text size="sm" className="ct-mono" lineClamp={1}>
                              {e.errorCode}
                            </Text>
                            {plain !== e.errorCode && (
                              <Text size="xs" color="dimmed" lineClamp={1}>
                                {plain}
                              </Text>
                            )}
                          </Stack>
                        </Group>
                      </td>
                      <td>
                        {jobsLoading ? (
                          <Skeleton height={14} width={120} radius="sm" />
                        ) : (
                          <Anchor component={Link} to={`/jobs/show/${e.jobId}`} size="sm">
                            {name ?? 'Deleted job'}
                          </Anchor>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <Anchor
                          component={Link}
                          to={failedRunsOf(e.jobId)}
                          size="sm"
                          aria-label={`${e.count.toLocaleString()} failed runs of ${name ?? 'this job'}: view them`}
                        >
                          {e.count.toLocaleString()}
                        </Anchor>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </Table>
        )}
      </Stack>
    </Stack>
  );
}
