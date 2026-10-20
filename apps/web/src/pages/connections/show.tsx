import { endpointProvider } from '@cloud-trigger/core';
import { Anchor, Badge, Code, SimpleGrid, Stack, Table, Text } from '@mantine/core';
import { useShow } from '@refinedev/core';
import { Show } from '@refinedev/mantine';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';

import { type ConnectionDto, type ConnectionUsagesDto, client } from '../../lib/api';
import { ConnectionTestButton } from './form';
import { connectionAddress, endpointSummary } from './summary';

const KIND_LABEL = { target: 'Target', trigger: 'Event source', notifier: 'Notifier' } as const;

interface UsageRow {
  readonly id: string;
  readonly kind: 'Job' | 'Group';
  readonly name: string;
  readonly to: string;
  readonly endpoints: readonly string[];
}

const usageRows = (usages: ConnectionUsagesDto | undefined): UsageRow[] => [
  ...(usages?.jobs ?? []).map((job) => ({
    id: job.id,
    kind: 'Job' as const,
    name: job.name,
    to: `/jobs/show/${job.id}`,
    endpoints: job.endpoints,
  })),
  ...(usages?.groups ?? []).map((group) => ({
    id: group.id,
    kind: 'Group' as const,
    name: group.name,
    to: `/groups/show/${group.id}`,
    endpoints: group.endpoints,
  })),
];

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
                No endpoints. Jobs and notification rules configure the details themselves.
              </Text>
            ) : (
              <Table className="ct-table" verticalSpacing="xs" fontSize="sm">
                <thead>
                  <tr>
                    <th>Endpoint</th>
                    <th>Kind</th>
                    <th>Configuration</th>
                  </tr>
                </thead>
                <tbody>
                  {connection.endpoints.map((endpoint) => {
                    const { kind, ref } = endpointProvider(endpoint);

                    return (
                      <tr key={endpoint.key}>
                        <td>
                          <Text size="sm" weight={600}>
                            {endpoint.name || endpoint.key}
                          </Text>
                          <Text size="xs" color="dimmed" ff="monospace">
                            {connection.key}/{endpoint.key}
                          </Text>
                        </td>
                        <td>{KIND_LABEL[kind]}</td>
                        <td>
                          <Code>{endpointSummary(ref)}</Code>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </Stack>

          <Stack className="ct-panel" p="lg" spacing="sm">
            <Text weight={600}>Used by</Text>
            {usageRows(usages.data).length === 0 ? (
              <Text size="sm" color="dimmed">
                Nothing uses this connection yet. Pick it in a job&apos;s &ldquo;Where it
                goes&rdquo;, &ldquo;When it runs&rdquo; or &ldquo;Notifications&rdquo; section, or
                in a group&apos;s default notifications.
              </Text>
            ) : (
              <Table className="ct-table" verticalSpacing="xs" fontSize="sm">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Kind</th>
                    <th>Endpoints</th>
                  </tr>
                </thead>
                <tbody>
                  {usageRows(usages.data).map((row) => (
                    <tr key={row.id}>
                      <td>
                        <Anchor component={Link} to={row.to} size="sm">
                          {row.name}
                        </Anchor>
                      </td>
                      <td>{row.kind}</td>
                      <td>
                        {row.endpoints.length > 0 ? row.endpoints.join(', ') : 'Base connection'}
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
