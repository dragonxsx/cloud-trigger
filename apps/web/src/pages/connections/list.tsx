import { Badge, Code, Pagination, ScrollArea, Stack, Table, Text } from '@mantine/core';
import { useTable } from '@refinedev/core';
import { EditButton, List, ShowButton } from '@refinedev/mantine';

import type { ConnectionDto } from '../../lib/api';
import { connectionAddress } from './summary';

export function ConnectionList() {
  const { tableQuery, currentPage, setCurrentPage, pageCount } = useTable<ConnectionDto>({
    resource: 'connections',
    pagination: { pageSize: 50 },
  });
  const connections = tableQuery.data?.data ?? [];

  return (
    <List title="Connections">
      <Stack spacing="md">
        {connections.length === 0 && !tableQuery.isLoading ? (
          <Text color="dimmed" p="lg" align="center">
            No connections yet. A connection keeps an API&apos;s address and credentials in one
            place, with named endpoints that jobs pick.
          </Text>
        ) : (
          <ScrollArea>
            <Table highlightOnHover verticalSpacing="xs" className="ct-table" miw={720}>
              <thead>
                <tr>
                  <th>Key</th>
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
                      <Text size="sm" weight={600}>
                        {connection.name || connection.key}
                      </Text>
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
                      <ShowButton hideText size="xs" recordItemId={connection.key} />
                      <EditButton hideText size="xs" recordItemId={connection.key} />
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
