import { Anchor, SimpleGrid, Stack, Table, Text } from '@mantine/core';
import { useList, useShow } from '@refinedev/core';
import { Show } from '@refinedev/mantine';
import { Link } from 'react-router';

import { GroupChip } from '../../components/GroupChip';
import type { GroupDto, JobDto } from '../../lib/api';
import { fromNow } from '../../lib/format';
import { JobState } from '../jobs/state';
import { rateLimitSummary } from './list';

export function GroupShow() {
  const { query } = useShow<GroupDto>({ resource: 'groups' });
  const group = query.data?.data;
  const members = useList<JobDto>({
    resource: 'jobs',
    filters: [{ field: 'groupId', operator: 'eq', value: group?.id }],
    pagination: { pageSize: 100 },
    queryOptions: { enabled: group !== undefined },
  });

  return (
    <Show isLoading={query.isLoading} title={group ? <GroupChip group={group} /> : 'Group'}>
      {group && (
        <Stack spacing="lg">
          {group.description && <Text>{group.description}</Text>}
          <SimpleGrid
            cols={3}
            breakpoints={[{ maxWidth: 'sm', cols: 1 }]}
            className="ct-panel"
            p="lg"
          >
            <Stack spacing={2}>
              <Text size="sm" color="dimmed">
                Rate limit
              </Text>
              <Text size="sm">{rateLimitSummary(group)}</Text>
            </Stack>
            <Stack spacing={2}>
              <Text size="sm" color="dimmed">
                Default notifications
              </Text>
              <Text size="sm">{group.defaultNotifications.length}</Text>
            </Stack>
            <Stack spacing={2}>
              <Text size="sm" color="dimmed">
                Jobs
              </Text>
              <Text size="sm">{members.result.total ?? 0}</Text>
            </Stack>
          </SimpleGrid>
          <Stack className="ct-panel" p="lg" spacing="sm">
            <Text weight={600}>Jobs in this group</Text>
            {members.result.data.length === 0 ? (
              <Text size="sm" color="dimmed">
                No jobs yet. Pick this group in a job&apos;s Basics section.
              </Text>
            ) : (
              <Table className="ct-table" verticalSpacing="xs" fontSize="sm">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>State</th>
                    <th>Next run</th>
                  </tr>
                </thead>
                <tbody>
                  {members.result.data.map((job) => (
                    <tr key={job.id}>
                      <td>
                        <Anchor component={Link} to={`/jobs/show/${job.id}`} size="sm">
                          {job.name}
                        </Anchor>
                      </td>
                      <td>
                        <JobState job={job} />
                      </td>
                      <td>{fromNow(job.schedule.nextFireAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Stack>
        </Stack>
      )}
    </Show>
  );
}
