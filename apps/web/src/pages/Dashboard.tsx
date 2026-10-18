import {
  Anchor,
  Group,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { useInterval } from '@mantine/hooks';
import { useList } from '@refinedev/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';

import { LatencyChart, RunsOverTimeChart } from '../components/charts';
import { type JobDto, client } from '../lib/api';
import { duration, fromNow, percent } from '../lib/format';
import { STATUS } from '../lib/status';

const RANGES = {
  '24h': { ms: 86_400_000, bucket: 'hour' },
  '7d': { ms: 7 * 86_400_000, bucket: 'hour' },
  '30d': { ms: 30 * 86_400_000, bucket: 'day' },
} as const;
type RangeKey = keyof typeof RANGES;
const isRange = (v: string): v is RangeKey => v in RANGES;

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Stack spacing={2}>
      <Text size="sm" color="dimmed">
        {label}
      </Text>
      <Text size={30} weight={650} lh={1.1} style={{ letterSpacing: '-0.02em' }}>
        {value}
      </Text>
      {hint && (
        <Text size="xs" color="dimmed">
          {hint}
        </Text>
      )}
    </Stack>
  );
}

export function Dashboard() {
  const [range, setRange] = useState<RangeKey>('24h');
  const [now, setNow] = useState(() => Date.now());
  const interval = useInterval(() => setNow(Date.now()), 60_000);
  useEffect(() => {
    interval.start();

    return interval.stop;
  }, [interval]);

  const timeWindow = useMemo(() => {
    const to = now + 60_000;

    return { from: new Date(to - RANGES[range].ms).toISOString(), to: new Date(to).toISOString() };
  }, [range, now]);

  const summary = useQuery({
    queryKey: ['analytics', 'summary', timeWindow],
    queryFn: () => client.analytics.summary(timeWindow),
  });
  const series = useQuery({
    queryKey: ['analytics', 'timeseries', timeWindow],
    queryFn: () => client.analytics.timeseries({ ...timeWindow, bucket: RANGES[range].bucket }),
  });
  const errors = useQuery({
    queryKey: ['analytics', 'errors', timeWindow],
    queryFn: () => client.analytics.topErrors({ ...timeWindow, limit: 8 }),
  });
  const jobs = useList<JobDto>({ resource: 'jobs', pagination: { mode: 'off' }, liveMode: 'auto' });

  const jobList = jobs.result.data;
  const jobName = useMemo(() => new Map(jobList.map((j) => [j.id, j.name])), [jobList]);
  const upcoming = useMemo(
    () =>
      jobList
        .filter((j) => j.enabled && j.pausedReason === null && j.schedule.nextFireAt !== null)
        .toSorted((a, b) =>
          (a.schedule.nextFireAt ?? '').localeCompare(b.schedule.nextFireAt ?? ''),
        )
        .slice(0, 8),
    [jobList],
  );
  const s = summary.data;
  const failures = (s?.byStatus.failed ?? 0) + (s?.byStatus.timed_out ?? 0);

  return (
    <Stack spacing="lg" maw={1280}>
      <Group position="apart" align="flex-end">
        <Title order={2}>Dashboard</Title>
        <SegmentedControl
          value={range}
          onChange={(v) => isRange(v) && setRange(v)}
          data={[
            { value: '24h', label: 'Last 24 hours' },
            { value: '7d', label: '7 days' },
            { value: '30d', label: '30 days' },
          ]}
        />
      </Group>

      <SimpleGrid
        cols={5}
        spacing="xl"
        breakpoints={[
          { maxWidth: 'lg', cols: 3 },
          { maxWidth: 'sm', cols: 2 },
        ]}
        className="ct-panel"
        p="lg"
      >
        <Stat label="Runs" value={s ? s.total.toLocaleString() : '—'} />
        <Stat
          label="Success rate"
          value={percent(s?.successRate ?? null)}
          hint={`${failures.toLocaleString()} failed or timed out`}
        />
        <Stat label="Median latency" value={duration(s?.p50Ms)} />
        <Stat label="p95 latency" value={duration(s?.p95Ms)} />
        <Stat
          label="Late"
          value={s ? s.late.toLocaleString() : '—'}
          hint={
            s && s.total > 0 ? `${percent(s.late / s.total)} of runs broke an SLA` : 'SLA breaches'
          }
        />
      </SimpleGrid>

      <Stack className="ct-panel" p="lg" spacing="xs">
        <Text weight={600}>Runs by outcome</Text>
        <RunsOverTimeChart points={series.data ?? []} height={280} pinnedWindow={timeWindow} />
      </Stack>

      <SimpleGrid cols={2} spacing="lg" breakpoints={[{ maxWidth: 'lg', cols: 1 }]}>
        <Stack className="ct-panel" p="lg" spacing="xs">
          <Text weight={600}>p95 latency</Text>
          <LatencyChart points={series.data ?? []} height={220} pinnedWindow={timeWindow} />
        </Stack>
        <Stack className="ct-panel" p="lg" spacing="xs">
          <Text weight={600}>Next up</Text>
          {upcoming.length === 0 ? (
            <Text color="dimmed" size="sm">
              Nothing is scheduled. Create a job or resume a paused one.
            </Text>
          ) : (
            <Table verticalSpacing={6}>
              <tbody>
                {upcoming.map((j) => (
                  <tr key={j.id}>
                    <td>
                      <Anchor component={Link} to={`/jobs/show/${j.id}`} size="sm">
                        {j.name}
                      </Anchor>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <Text size="sm" color="dimmed">
                        {fromNow(j.schedule.nextFireAt)}
                      </Text>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Stack>
      </SimpleGrid>

      <Stack className="ct-panel" p="lg" spacing="xs">
        <Text weight={600}>Most frequent errors</Text>
        {(errors.data ?? []).length === 0 ? (
          <Text color="dimmed" size="sm">
            No errors in this period.
          </Text>
        ) : (
          <Table verticalSpacing={6} className="ct-table">
            <thead>
              <tr>
                <th>Error</th>
                <th>Job</th>
                <th style={{ textAlign: 'right' }}>Runs</th>
              </tr>
            </thead>
            <tbody>
              {(errors.data ?? []).map((e) => (
                <tr key={`${e.jobId}:${e.errorCode}`}>
                  <td>
                    <Group spacing={6}>
                      <span style={{ color: STATUS.failed.color, display: 'inline-flex' }}>
                        {STATUS.failed.icon}
                      </span>
                      <Text size="sm" className="ct-mono">
                        {e.errorCode}
                      </Text>
                    </Group>
                  </td>
                  <td>
                    <Anchor component={Link} to={`/jobs/show/${e.jobId}`} size="sm">
                      {jobName.get(e.jobId) ?? e.jobId}
                    </Anchor>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <Text size="sm">{e.count.toLocaleString()}</Text>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Stack>
    </Stack>
  );
}
