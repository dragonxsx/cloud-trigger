import { endpointProvider, isRecord, mergePatch } from '@cloud-trigger/core';
import { Anchor, Badge, Code, Divider, SimpleGrid, Stack, Table, Text } from '@mantine/core';
import { useShow } from '@refinedev/core';
import { Show } from '@refinedev/mantine';
import { skipToken, useQuery } from '@tanstack/react-query';
import { Fragment } from 'react';
import { Link } from 'react-router';

import { PageHeading, backIcon, pageBreadcrumb } from '../../components/page-chrome';
import { RecordLoadError } from '../../components/PageState';
import { usePageTitle } from '../../components/usePageTitle';
import { type ConnectionDto, type ConnectionUsagesDto, orpc } from '../../lib/api';
import { environmentLabel, useEnvironments } from '../../lib/environments';
import { countOf } from '../../lib/format';
import { ConnectionTestButton } from './form';
import { connectionAddress, endpointSummary, overriddenFields, overrideLabel } from './summary';

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

function EnvironmentsPanel({ connection }: { connection: ConnectionDto }) {
  const environments = useEnvironments();
  const labelOf = (key: string) => {
    const found = environments.data?.find((environment) => environment.key === key);

    return found ? environmentLabel(found) : key;
  };

  return (
    <Stack className="ct-panel" p="lg" spacing="sm">
      <div>
        <Text weight={600}>Environments</Text>
        <Text size="sm" color="dimmed">
          Overlays change the address, credentials or endpoints in one environment. Other
          environments use the base config.
        </Text>
      </div>
      {connection.overlays.length === 0 ? (
        <Text size="sm" color="dimmed">
          No overlays. Every environment uses the base config.
        </Text>
      ) : (
        connection.overlays.map((overlay, index) => {
          const label = labelOf(overlay.environment);
          const count = overriddenFields(overlay);
          const config = isRecord(overlay.config)
            ? mergePatch(connection.config, overlay.config)
            : connection.config;

          return (
            <Fragment key={overlay.environment}>
              {index > 0 && <Divider />}
              <Stack spacing={6}>
                <div>
                  <Text size="sm" weight={600}>
                    {label}
                    <Text span color="dimmed" weight={400} ml="xs">
                      {overrideLabel(count, 'no overrides')}
                      {overlay.endpoints.length > 0 &&
                        ` · ${countOf(overlay.endpoints.length, 'endpoint')} changed`}
                    </Text>
                  </Text>
                  <Code>{connectionAddress({ config })}</Code>
                </div>
                <ConnectionTestButton
                  type={connection.type}
                  config={connection.config}
                  savedKey={connection.key}
                  overlay={{ environment: overlay.environment, config: overlay.config ?? {} }}
                  label={`Test ${label}`}
                />
              </Stack>
            </Fragment>
          );
        })
      )}
    </Stack>
  );
}

export function ConnectionShow() {
  const { query } = useShow<ConnectionDto>({ resource: 'connections', errorNotification: false });
  const connection = query.data?.data;
  const title = connection ? connection.name || connection.key : undefined;
  usePageTitle(title, 'Connections');
  const key = connection?.key;
  const usages = useQuery(
    orpc.connections.usages.queryOptions({ input: key === undefined ? skipToken : { key } }),
  );

  if (query.isError) {
    return (
      <RecordLoadError
        error={query.error}
        onRetry={() => void query.refetch()}
        resource="Connection"
        listPath="/connections"
        listLabel="Connections"
      />
    );
  }

  return (
    <Show
      isLoading={query.isLoading}
      goBack={backIcon}
      breadcrumb={pageBreadcrumb}
      title={<PageHeading>{title ?? 'Connection'}</PageHeading>}
    >
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
            <div>
              <Text weight={600}>Test connection</Text>
              {connection.overlays.length > 0 && (
                <Text size="sm" color="dimmed">
                  Checks the base config. Test each environment under Environments.
                </Text>
              )}
            </div>
            <ConnectionTestButton
              type={connection.type}
              config={connection.config}
              savedKey={connection.key}
            />
          </Stack>

          <EnvironmentsPanel connection={connection} />

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
