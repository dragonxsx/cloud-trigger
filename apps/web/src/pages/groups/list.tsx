import { ActionIcon, Pagination, ScrollArea, Stack, Table, Text } from '@mantine/core';
import { CanAccess, useTable } from '@refinedev/core';
import { List } from '@refinedev/mantine';
import { IconPencil } from '@tabler/icons-react';
import { Link } from 'react-router';

import { GroupChip } from '../../components/GroupChip';
import { PageHeading } from '../../components/page-chrome';
import type { GroupDto } from '../../lib/api';

export const rateLimitSummary = (group: Pick<GroupDto, 'rateLimit'>): string => {
  const limit = group.rateLimit;
  if (!limit) {
    return 'Unlimited';
  }
  const parts = [
    limit.perSecond !== undefined ? `${limit.perSecond}/s` : undefined,
    limit.maxConcurrent !== undefined ? `${limit.maxConcurrent} at once` : undefined,
  ];

  return parts.filter((p) => p !== undefined).join(', ');
};

export function GroupList() {
  const { tableQuery, currentPage, setCurrentPage, pageCount } = useTable<GroupDto>({
    resource: 'groups',
    pagination: { pageSize: 50 },
  });
  const groups = tableQuery.data?.data ?? [];

  return (
    <List title={<PageHeading>Groups</PageHeading>}>
      <Stack spacing="md">
        {groups.length === 0 && !tableQuery.isLoading ? (
          <Text color="dimmed" p="lg" align="center">
            No groups yet. Groups share default policies, notifications and rate limits across jobs.
          </Text>
        ) : (
          <ScrollArea>
            <Table highlightOnHover verticalSpacing="xs" className="ct-table" miw={720}>
              <thead>
                <tr>
                  <th>Group</th>
                  <th>Description</th>
                  <th>Rate limit</th>
                  <th style={{ textAlign: 'right' }}>Default notifications</th>
                  <th>
                    <span className="ct-sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <tr key={group.id}>
                    <td>
                      <GroupChip group={group} />
                    </td>
                    <td style={{ maxWidth: 360 }}>
                      <Text size="sm" color="dimmed" lineClamp={1}>
                        {group.description || '—'}
                      </Text>
                    </td>
                    <td>
                      <Text size="sm">{rateLimitSummary(group)}</Text>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <Text size="sm">{group.defaultNotifications.length}</Text>
                    </td>
                    <td>
                      <CanAccess resource="groups" action="edit">
                        <ActionIcon
                          component={Link}
                          to={`/groups/edit/${group.id}`}
                          variant="subtle"
                          size="lg"
                          aria-label={`Edit ${group.name}`}
                          title={`Edit ${group.name}`}
                        >
                          <IconPencil size={18} />
                        </ActionIcon>
                      </CanAccess>
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
