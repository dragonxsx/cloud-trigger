import {
  ActionIcon,
  Anchor,
  Badge,
  Code,
  Group,
  Pagination,
  ScrollArea,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import { useCan, useTable } from '@refinedev/core';
import { List } from '@refinedev/mantine';
import { IconChevronRight, IconPencil } from '@tabler/icons-react';
import { Link } from 'react-router';

import { PageHeading } from '../../components/page-chrome';
import { LoadError } from '../../components/PageState';
import type { ConnectionDto } from '../../lib/api';
import { connectionAddress } from './summary';

export function ConnectionList() {
  const { tableQuery, currentPage, setCurrentPage, pageCount } = useTable<ConnectionDto>({
    resource: 'connections',
    pagination: { pageSize: 50 },
  });
  const connections = tableQuery.data?.data ?? [];
  const canEdit = useCan({ resource: 'connections', action: 'edit' }).data?.can === true;

  return (
    <List title={<PageHeading>Connections</PageHeading>}>
      <Stack spacing="md">
        {tableQuery.isError ? (
          <LoadError
            error={tableQuery.error}
            what="connections"
            onRetry={() => void tableQuery.refetch()}
          />
        ) : connections.length === 0 && !tableQuery.isLoading ? (
          <Text color="dimmed" p="lg" align="center">
            No connections yet. A connection keeps an API&apos;s address and credentials in one
            place, with named endpoints that jobs pick.
          </Text>
        ) : (
          <ScrollArea>
            <Table highlightOnHover verticalSpacing="xs" className="ct-table" miw={720}>
              <thead>
                <tr>
                  <th>Connection</th>
                  <th>Type</th>
                  <th>Address</th>
                  <th style={{ textAlign: 'right' }}>Endpoints</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {connections.map((connection) => (
                  <tr key={connection.key}>
                    <td>
                      <Anchor
                        component={Link}
                        to={`/connections/show/${connection.key}`}
                        size="sm"
                        weight={600}
                      >
                        {connection.name || connection.key}
                      </Anchor>
                      {connection.name && (
                        <Text size="xs" color="dimmed" ff="monospace">
                          {connection.key}
                        </Text>
                      )}
                    </td>
                    <td>
                      <Badge variant="outline" radius="sm">
                        {connection.type}
                      </Badge>
                    </td>
                    <td style={{ maxWidth: 360 }}>
                      <Code>{connectionAddress(connection)}</Code>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <Text size="sm">{connection.endpoints.length}</Text>
                    </td>
                    <td>
                      <Group spacing={4} noWrap position="right">
                        {canEdit && (
                          <ActionIcon
                            component={Link}
                            to={`/connections/edit/${connection.key}`}
                            size="lg"
                            variant="subtle"
                            aria-label={`Edit ${connection.name || connection.key}`}
                          >
                            <IconPencil size={18} />
                          </ActionIcon>
                        )}
                        <ActionIcon
                          component={Link}
                          to={`/connections/show/${connection.key}`}
                          size="lg"
                          variant="subtle"
                          aria-label={`Open ${connection.name || connection.key}`}
                        >
                          <IconChevronRight size={18} />
                        </ActionIcon>
                      </Group>
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
