import {
  Anchor,
  Badge,
  Group,
  Pagination,
  ScrollArea,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useTable } from '@refinedev/core';
import { List, ShowButton } from '@refinedev/mantine';
import { IconSearch } from '@tabler/icons-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';

import { GroupChip } from '../../components/GroupChip';
import { JobTransferButtons } from '../../components/JobTransferButtons';
import { CalendarButton } from '../../components/ShareButtons';
import type { GroupDto, JobDto } from '../../lib/api';
import { fromNow } from '../../lib/format';
import { useGroupsById } from '../../lib/groups';
import { targetSummary, triggerSummary } from '../../lib/job-summary';
import { JobState } from './state';

const jobListHeader = ({ defaultButtons }: { defaultButtons: ReactNode }) => (
  <Group spacing="xs">
    <CalendarButton />
    <JobTransferButtons />
    {defaultButtons}
  </Group>
);

function MemberOf({
  groupId,
  groups,
}: {
  groupId: string | null;
  groups: ReadonlyMap<string, GroupDto>;
}) {
  const group = groupId === null ? undefined : groups.get(groupId);

  return group ? <GroupChip group={group} /> : null;
}

export function JobList() {
  const [search, setSearch] = useState('');
  const [debounced] = useDebouncedValue(search, 250);
  const { tableQuery, currentPage, setCurrentPage, pageCount, setFilters } = useTable<JobDto>({
    resource: 'jobs',
    pagination: { pageSize: 20 },
    syncWithLocation: true,
  });
  useEffect(() => {
    setFilters([{ field: 'search', operator: 'contains', value: debounced }], 'replace');
  }, [debounced, setFilters]);
  const items = tableQuery.data?.data ?? [];
  const groups = useGroupsById();

  return (
    <List title="Jobs" headerButtons={jobListHeader}>
      <Stack spacing="md">
        <TextInput
          placeholder="Search by name"
          icon={<IconSearch size={16} />}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          maw={360}
          aria-label="Search jobs"
        />
        {items.length === 0 && !tableQuery.isLoading ? (
          <Text color="dimmed" p="lg" align="center">
            {debounced
              ? `No jobs match “${debounced}”.`
              : 'No jobs yet. Create one to start calling an endpoint on a schedule.'}
          </Text>
        ) : (
          <ScrollArea>
            <Table highlightOnHover verticalSpacing="xs" className="ct-table" miw={860}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>State</th>
                  <th>Schedule</th>
                  <th>Target</th>
                  <th>Next run</th>
                  <th>Last success</th>
                  <th style={{ textAlign: 'right' }}>Failures in a row</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {items.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <Anchor component={Link} to={`/jobs/show/${job.id}`} weight={600} size="sm">
                        {job.name}
                      </Anchor>
                      {(job.tags.length > 0 || job.groupId !== null) && (
                        <Group spacing={4} mt={2}>
                          <MemberOf groupId={job.groupId} groups={groups} />
                          {job.tags.map((t) => (
                            <Badge key={t} size="xs" variant="outline" color="gray" tt="none">
                              {t}
                            </Badge>
                          ))}
                        </Group>
                      )}
                    </td>
                    <td>
                      <JobState job={job} />
                    </td>
                    <td>
                      <Text size="sm" className="ct-mono">
                        {triggerSummary(job)}
                      </Text>
                    </td>
                    <td style={{ maxWidth: 280 }}>
                      <Text size="sm" color="dimmed" lineClamp={1}>
                        {targetSummary(job)}
                      </Text>
                    </td>
                    <td>
                      <Text size="sm">{fromNow(job.schedule.nextFireAt)}</Text>
                    </td>
                    <td>
                      <Text size="sm" color="dimmed">
                        {fromNow(job.schedule.lastSuccessAt)}
                      </Text>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <Text
                        size="sm"
                        color={job.schedule.consecutiveFailures > 0 ? 'red' : 'dimmed'}
                      >
                        {job.schedule.consecutiveFailures}
                      </Text>
                    </td>
                    <td>
                      <ShowButton hideText size="xs" recordItemId={job.id} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </ScrollArea>
        )}
        {pageCount > 1 && (
          <Pagination
            page={currentPage}
            total={pageCount}
            onChange={setCurrentPage}
            position="right"
          />
        )}
      </Stack>
    </List>
  );
}
