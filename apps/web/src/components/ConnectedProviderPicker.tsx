import { type EndpointKind, endpointProvider, isRecord } from '@cloud-trigger/core';
import { Select, SimpleGrid, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import type { ConnectionDto, ProviderDto } from '../lib/api';
import { listAllConnections } from '../lib/connections';
import type { ConfigIssueDto } from '../lib/errors';
import { ProviderConfigForm } from './ProviderConfigForm';

export interface ConnectionValue {
  readonly key: string;
  readonly endpoint?: string | undefined;
}

export interface ConnectedValue {
  readonly type: string;
  readonly config?: unknown;
  readonly connection?: ConnectionValue | undefined;
}

export interface ConnectedChange {
  type: string;
  config: unknown;
  connection?: ConnectionValue;
}

const COPY: Record<
  EndpointKind,
  {
    label: string;
    connection: string;
    none: string;
    endpoint: string;
    endpointNone: string;
    saved: string;
  }
> = {
  target: {
    label: 'Target',
    connection: 'A saved API or broker with its address and credentials.',
    none: 'None: enter the full address below',
    endpoint: 'A request saved on the connection.',
    endpointNone: 'None: configure the request below',
    saved: 'Runs',
  },
  trigger: {
    label: 'Trigger',
    connection: 'A saved broker or account the consumer connects with.',
    none: 'None: enter the broker settings below',
    endpoint: 'A source (queue, topic or stream) saved on the connection.',
    endpointNone: 'None: configure the source below',
    saved: 'Consumes',
  },
};

const PATCH_DROPPED = new Set(['required', 'default']);

export function patchSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item: unknown) => patchSchema(item));
  }
  if (!isRecord(schema)) {
    return schema;
  }

  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => !PATCH_DROPPED.has(key))
      .map(([key, value]) => [key, patchSchema(value)]),
  );
}

const asOverrides = (provider: ProviderDto): ProviderDto => {
  const schema = patchSchema(provider.configSchema);

  return isRecord(schema) ? { ...provider, configSchema: schema } : provider;
};

export function forConnection(provider: ProviderDto): ProviderDto {
  const owned = new Set(provider.connectionFields ?? []);
  const schema = provider.configSchema;
  const properties = schema['properties'];
  const required = schema['required'];
  if (owned.size === 0 || !isRecord(properties)) {
    return provider;
  }

  return {
    ...provider,
    configSchema: {
      ...schema,
      properties: Object.fromEntries(Object.entries(properties).filter(([key]) => !owned.has(key))),
      ...(Array.isArray(required) && {
        required: required.filter((key: unknown) => typeof key !== 'string' || !owned.has(key)),
      }),
    },
  };
}

const change = (
  type: string,
  config: unknown,
  connection: ConnectionValue | undefined,
): ConnectedChange => ({ type, config, ...(connection && { connection }) });

interface Props {
  readonly kind: EndpointKind;
  readonly providers: readonly ProviderDto[];
  readonly value: ConnectedValue;
  readonly configIssues: readonly ConfigIssueDto[];
  readonly connectionError?: string | undefined;
  readonly endpointError?: string | undefined;
  readonly onChange: (next: ConnectedChange) => void;
}

export function ConnectedProviderPicker({
  kind,
  providers,
  value,
  configIssues,
  connectionError,
  endpointError,
  onChange,
}: Props) {
  const connections = useQuery({
    queryKey: ['connections', 'all'],
    queryFn: () => listAllConnections(),
    staleTime: 30_000,
  });
  const usable = useMemo(() => {
    const types = new Set(providers.flatMap((p) => p.connectionType ?? []));

    return (connections.data ?? []).filter((c) => types.has(c.type));
  }, [connections.data, providers]);
  const connection: ConnectionDto | undefined = usable.find((c) => c.key === value.connection?.key);
  const endpoints = useMemo(
    () =>
      (connection?.endpoints ?? []).flatMap((e) => {
        const saved = endpointProvider(e);

        return saved.kind === kind ? [{ key: e.key, name: e.name, ref: saved.ref }] : [];
      }),
    [connection, kind],
  );
  const endpointKey = value.connection?.endpoint;
  const endpoint = endpoints.find((e) => e.key === endpointKey);
  const copy = COPY[kind];
  const connectable =
    kind === 'target' ||
    value.connection !== undefined ||
    providers.some((p) => p.type === value.type && p.connectionType !== undefined);

  const choices = useMemo(() => {
    if (endpoint) {
      return providers
        .filter((p) => p.type === endpoint.ref.type)
        .map((p) => asOverrides(forConnection(p)));
    }
    if (value.connection) {
      return providers
        .filter((p) =>
          connection
            ? p.connectionType !== undefined && p.connectionType === connection.type
            : p.type === value.type,
        )
        .map(forConnection);
    }

    return providers;
  }, [providers, endpoint, value.connection, value.type, connection]);

  const pickConnection = (key: string | null) => {
    const picked = usable.find((c) => c.key === key);
    if (!picked) {
      onChange(change(value.type, {}, undefined));

      return;
    }
    const compatible = providers.find((p) => p.type === value.type)?.connectionType === picked.type;
    const type = compatible
      ? value.type
      : (providers.find((p) => p.connectionType === picked.type)?.type ?? value.type);
    onChange(change(type, {}, { key: picked.key }));
  };

  const pickEndpoint = (key: string | null) => {
    if (!connection) {
      return;
    }
    const picked = endpoints.find((e) => e.key === key);
    onChange(
      picked
        ? change(picked.ref.type, {}, { key: connection.key, endpoint: picked.key })
        : change(value.type, {}, { key: connection.key }),
    );
  };

  return (
    <Stack spacing="sm">
      {connectable && (
        <SimpleGrid cols={2} breakpoints={[{ maxWidth: 'sm', cols: 1 }]}>
          <Select
            label="Connection"
            description={copy.connection}
            placeholder={copy.none}
            clearable
            searchable
            nothingFound="No connections yet"
            data={usable.map((c) => ({ value: c.key, label: c.name || c.key, group: c.type }))}
            value={value.connection?.key ?? null}
            error={connectionError}
            onChange={pickConnection}
          />
          <Select
            label="Endpoint"
            description={copy.endpoint}
            placeholder={connection ? copy.endpointNone : 'Pick a connection first'}
            clearable
            disabled={!connection || endpoints.length === 0}
            data={endpoints.map((e) => ({ value: e.key, label: e.name || e.key }))}
            value={endpointKey ?? null}
            error={endpointError}
            onChange={pickEndpoint}
          />
        </SimpleGrid>
      )}
      {endpoint && (
        <Text size="sm" color="dimmed">
          {copy.saved} {connection?.key}/{endpoint.key} as saved. Fields set below override it for
          this job only.
        </Text>
      )}
      <ProviderConfigForm
        label={copy.label}
        providers={choices}
        type={value.type}
        config={value.config}
        configIssues={configIssues}
        onTypeChange={(type) => onChange(change(type, {}, value.connection))}
        onConfigChange={(config) => onChange(change(value.type, config, value.connection))}
      />
    </Stack>
  );
}
