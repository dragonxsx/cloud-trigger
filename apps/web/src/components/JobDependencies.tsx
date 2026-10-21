import { Anchor, Group, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { IconArrowDownRight, IconArrowUpRight } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';

import { type ApiClient, type JobDto, client } from '../lib/api';

type Summary = Awaited<ReturnType<ApiClient['jobs']['dependencies']>>['upstream'][number];

function JobLinks({ jobs, empty }: { jobs: readonly Summary[]; empty: string }) {
  if (jobs.length === 0) {
    return (
      <Text size="sm" color="dimmed">
        {empty}
      </Text>
    );
  }

  return (
    <Stack spacing={4}>
      {jobs.map((j) => (
        <Anchor key={j.id} component={Link} to={`/jobs/show/${j.id}`} size="sm">
          {j.name}
          {!j.enabled ? ' (disabled)' : j.pausedReason !== null ? ' (paused)' : ''}
        </Anchor>
      ))}
    </Stack>
  );
}

export function JobDependencies({ job }: { job: JobDto }) {
  const deps = useQuery({
    queryKey: ['jobs', job.id, 'dependencies', job.version],
    queryFn: () => client.jobs.dependencies({ id: job.id }),
  });
  const upstream = deps.data?.upstream ?? [];
  const downstream = deps.data?.downstream ?? [];
  if (upstream.length === 0 && downstream.length === 0) {
    return null;
  }

  return (
    <SimpleGrid cols={2} breakpoints={[{ maxWidth: 'sm', cols: 1 }]} className="ct-panel" p="lg">
      <Stack spacing="xs">
        <Group spacing={6}>
          <IconArrowUpRight size={16} aria-hidden />
          <Title order={2} size="h5">
            Runs after
          </Title>
        </Group>
        <JobLinks jobs={upstream} empty="Nothing; this job runs on its own schedule." />
      </Stack>
      <Stack spacing="xs">
        <Group spacing={6}>
          <IconArrowDownRight size={16} aria-hidden />
          <Title order={2} size="h5">
            Starts next
          </Title>
        </Group>
        <JobLinks jobs={downstream} empty="No jobs run after this one." />
      </Stack>
    </SimpleGrid>
  );
}
