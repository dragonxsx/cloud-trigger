import { Anchor, Badge, Code, SimpleGrid, Stack, Table, Text } from '@mantine/core';
import { useShow } from '@refinedev/core';
import { Show } from '@refinedev/mantine';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';

import { type ConnectionDto, client } from '../../lib/api';
import { ConnectionTestButton } from './form';
import { connectionAddress, endpointSummary } from './summary';

export function ConnectionShow() {
  const { query } = useShow<ConnectionDto>({ resource: 'connections' });
  const connection = query.data?.data;
  const usages = useQuery({
    queryKey: ['connections', 'usages', connection?.key],
    queryFn: () => client.connections.usages({ key: connection?.key ?? '' }),
    enabled: connection !== undefined,
  });

  return (
    <Show isLoading={query.isLoading} title={connection?.name || connection?.key || 'Connection'}>
      {connection && (
        <Stack spacing="lg">
          {connection.description && <Text>{connection.description}</Text>}
          <SimpleGrid
            cols={3}
            breakpoints={[{ maxWidth: 'sm', cols: 1 }]}
            className="ct-panel"
            p="lg"
          >
            <Stack spacing={2}>
              <Text size="sm" color="dimmed">
                Key
              </Text>
              <Code>{connection.key}</Code>
            </Stack>
            <Stack spacing={2}>
              <Text size="sm" color="dimmed">
                Type
              </Text>
              <div>
                <Badge variant="outline" radius="sm">
                  {connection.type}
                </Badge>
              </div>
            </Stack>
            <Stack spacing={2}>
              <Text size="sm" color="dimmed">
                Address
              </Text>
              <Code>{connectionAddress(connection)}</Code>
            </Stack>
          </SimpleGrid>

          <Stack className="ct-panel" p="lg" spacing="sm">
            <Text weight={600}>Check</Text>
            <ConnectionTestButton
              type={connection.type}
              config={connection.config}
              savedKey={connection.key}
            />
          </Stack>

          <Stack className="ct-panel" p="lg" spacing="sm">
            <Text weight={600}>Endpoints</Text>
            {connection.endpoints.length === 0 ? (
              <Text size="sm" color="dimmed">
                No endpoints. Jobs configure the request themselves.
              </Text>
            ) : (
              <Table className="ct-table" verticalSpacing="xs" fontSize="sm">
                <thead>
                  <tr>
                    <th>Endpoint</th>
                    <th>Request</th>
                  </tr>
                </thead>
                <tbody>
                  {connection.endpoints.map((endpoint) => (
                    <tr key={endpoint.key}>
                      <td>
                        <Text size="sm" weight={600}>
                          {endpoint.name || endpoint.key}
                        </Text>
                        <Text size="xs" color="dimmed" ff="monospace">
                          {connection.key}/{endpoint.key}
                        </Text>
                      </td>
                      <td>
                        <Code>{endpointSummary(endpoint.target)}</Code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Stack>

          <Stack className="ct-panel" p="lg" spacing="sm">
            <Text weight={600}>Used by</Text>
            {(usages.data ?? []).length === 0 ? (
              <Text size="sm" color="dimmed">
                No jobs use this connection yet. Pick it in a job&apos;s &ldquo;Where it goes&rdquo;
                section.
              </Text>
            ) : (
              <Table className="ct-table" verticalSpacing="xs" fontSize="sm">
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>Endpoints</th>
                  </tr>
                </thead>
                <tbody>
                  {(usages.data ?? []).map((job) => (
                    <tr key={job.id}>
                      <td>
                        <Anchor component={Link} to={`/jobs/show/${job.id}`} size="sm">
                          {job.name}
                        </Anchor>
                      </td>
                      <td>
                        {job.endpoints.length > 0 ? job.endpoints.join(', ') : 'Base connection'}
                      </td>
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
