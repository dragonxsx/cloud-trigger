import { type EndpointKind, assertNever, endpointProvider } from '@cloud-trigger/core';
import {
  Accordion,
  ActionIcon,
  Alert,
  Button,
  Group,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import type { UseFormReturnType } from '@mantine/form';
import { IconAlertCircle, IconCircleCheck, IconPlus, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type ReactNode, useMemo } from 'react';

import { forConnection } from '../../components/ConnectedProviderPicker';
import { ProviderConfigForm } from '../../components/ProviderConfigForm';
import { type ConnectionSpecDto, client } from '../../lib/api';
import type { ConfigIssueDto } from '../../lib/errors';
import { errorMessage } from '../../lib/errors';

interface ProviderRefValues {
  type: string;
  config: unknown;
}

interface EndpointFields {
  key: string;
  name: string;
  description: string;
}

type EndpointValues =
  | (EndpointFields & { target: ProviderRefValues })
  | (EndpointFields & { source: ProviderRefValues })
  | (EndpointFields & { notifier: ProviderRefValues });

const ENDPOINT_KINDS = ['target', 'trigger', 'notifier'] as const satisfies readonly EndpointKind[];

const KIND: Record<
  EndpointKind,
  { field: 'target' | 'source' | 'notifier'; label: string; form: string; suffix: string }
> = {
  target: { field: 'target', label: 'Target', form: 'Request', suffix: '' },
  trigger: { field: 'source', label: 'Event source', form: 'Event source', suffix: ' source' },
  notifier: { field: 'notifier', label: 'Notifier', form: 'Message', suffix: ' notifier' },
};

const endpointOf = (
  fields: EndpointFields,
  kind: EndpointKind,
  ref: ProviderRefValues,
): EndpointValues => {
  switch (kind) {
    case 'target':
      return { ...fields, target: ref };
    case 'trigger':
      return { ...fields, source: ref };
    case 'notifier':
      return { ...fields, notifier: ref };
    default:
      return assertNever(kind);
  }
};

const isEndpointKind = (value: string): value is EndpointKind =>
  ENDPOINT_KINDS.some((kind) => kind === value);

export interface ConnectionFormValues {
  key: string;
  name: string;
  description: string;
  type: string;
  config: unknown;
  endpoints: EndpointValues[];
  version?: number;
}

export type ConnectionForm = UseFormReturnType<
  ConnectionFormValues,
  (values: ConnectionFormValues) => ConnectionSpecDto & { expectedVersion?: number }
>;

export const blankConnection: ConnectionFormValues = {
  key: '',
  name: '',
  description: '',
  type: 'http',
  config: { baseUrl: 'https://', auth: { type: 'none' } },
  endpoints: [],
};

export const toConnectionSpec = ({
  version,
  ...v
}: ConnectionFormValues): ConnectionSpecDto & { expectedVersion?: number } => ({
  key: v.key.trim(),
  name: v.name,
  description: v.description,
  type: v.type,
  config: v.config,
  endpoints: v.endpoints,
  ...(version !== undefined && { expectedVersion: version }),
});

const issuesAt = (errors: Record<string, ReactNode>, prefix: string): ConfigIssueDto[] =>
  Object.entries(errors).flatMap(([path, message]) =>
    path.startsWith(prefix) && typeof message === 'string'
      ? [{ path: path.slice(prefix.length).replace(/^\./, ''), message }]
      : [],
  );

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Stack className="ct-panel" p="lg" spacing="md">
      <div>
        <Text weight={650}>{title}</Text>
        {hint && (
          <Text size="sm" color="dimmed">
            {hint}
          </Text>
        )}
      </div>
      {children}
    </Stack>
  );
}

function TestResult({ ok, message }: { ok: boolean; message: string }) {
  return (
    <Alert
      color={ok ? 'teal' : 'red'}
      icon={ok ? <IconCircleCheck size={18} /> : <IconAlertCircle size={18} />}
    >
      {message}
    </Alert>
  );
}

export function ConnectionTestButton({
  type,
  config,
  savedKey,
}: {
  type: string;
  config: unknown;
  savedKey?: string | undefined;
}) {
  const test = useMutation({
    mutationFn: () =>
      client.connections.test({ type, config, ...(savedKey !== undefined && { key: savedKey }) }),
  });

  return (
    <Stack spacing="xs">
      <Group>
        <Button variant="default" loading={test.isPending} onClick={() => test.mutate()}>
          Test connection
        </Button>
      </Group>
      {test.data && <TestResult ok={test.data.ok} message={test.data.message} />}
      {test.isError && <TestResult ok={false} message={errorMessage(test.error)} />}
    </Stack>
  );
}

export function ConnectionFormFields({
  form,
  editing = false,
}: {
  form: ConnectionForm;
  editing?: boolean;
}) {
  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: () => client.providers.list({}),
    staleTime: 300_000,
  });
  const all = providers.data ?? [];
  const connectionTypes = all.filter((p) => p.kind === 'connection');
  const choices = useMemo(() => {
    const over = (kind: EndpointKind) =>
      (providers.data ?? [])
        .filter((p) => p.kind === kind && p.connectionType === form.values.type)
        .map(forConnection);

    return { target: over('target'), trigger: over('trigger'), notifier: over('notifier') };
  }, [providers.data, form.values.type]);
  const { values, errors } = form;
  const setEndpoints = (endpoints: EndpointValues[]) => form.setFieldValue('endpoints', endpoints);
  const kinds = ENDPOINT_KINDS.filter((kind) => choices[kind].length > 0);
  const blankEndpoint = (fields: EndpointFields, kind: EndpointKind): EndpointValues =>
    endpointOf(fields, kind, { type: choices[kind][0]?.type ?? '', config: {} });
  const setKind = (index: number, kind: EndpointKind) =>
    setEndpoints(
      values.endpoints.map((endpoint, i) =>
        i === index
          ? blankEndpoint(
              { key: endpoint.key, name: endpoint.name, description: endpoint.description },
              kind,
            )
          : endpoint,
      ),
    );

  return (
    <Stack spacing="lg">
      <Section title="Basics">
        <SimpleGrid cols={2} breakpoints={[{ maxWidth: 'sm', cols: 1 }]}>
          <TextInput
            label="Key"
            description="Jobs reference the connection by this key. Define the same key in every deployment."
            required
            disabled={editing}
            {...form.getInputProps('key')}
          />
          <TextInput label="Display name" {...form.getInputProps('name')} />
        </SimpleGrid>
        <Textarea label="Description" autosize minRows={2} {...form.getInputProps('description')} />
      </Section>

      <Section
        title="Address and credentials"
        hint="Shared by every endpoint and job that uses this connection. Reference secrets as {{secret:NAME}}."
      >
        <ProviderConfigForm
          label="Type"
          providers={connectionTypes}
          type={values.type}
          config={values.config}
          configIssues={issuesAt(errors, 'config')}
          onTypeChange={(type) => {
            form.setFieldValue('type', type);
            form.setFieldValue('config', {});
            setEndpoints([]);
          }}
          onConfigChange={(config) => form.setFieldValue('config', config)}
        />
        <ConnectionTestButton
          type={values.type}
          config={values.config}
          savedKey={editing ? values.key : undefined}
        />
      </Section>

      <Section
        title="Endpoints"
        hint="Saved requests, event sources and notification messages that jobs and groups pick by name. Any field can still be overridden where it is used."
      >
        {values.endpoints.length === 0 ? (
          <Text size="sm" color="dimmed">
            No endpoints yet. Jobs can still use the connection and configure the request
            themselves.
          </Text>
        ) : (
          <Accordion variant="separated" multiple>
            {values.endpoints.map((endpoint, index) => {
              const { kind, ref } = endpointProvider(endpoint);
              const path = `endpoints.${index}.${KIND[kind].field}`;
              const base = `endpoints.${index}`;

              return (
                <Accordion.Item key={index} value={String(index)}>
                  <Accordion.Control>
                    <Text size="sm" weight={600}>
                      {endpoint.name || endpoint.key || 'New endpoint'}
                      <Text span color="dimmed" weight={400} ml="xs">
                        {ref.type}
                        {KIND[kind].suffix}
                      </Text>
                    </Text>
                  </Accordion.Control>
                  <Accordion.Panel>
                    <Stack spacing="sm">
                      <Group align="flex-end" grow>
                        <TextInput label="Key" required {...form.getInputProps(`${base}.key`)} />
                        <TextInput label="Display name" {...form.getInputProps(`${base}.name`)} />
                        <Group position="right" style={{ flexGrow: 0 }}>
                          <ActionIcon
                            color="red"
                            variant="subtle"
                            aria-label={`Remove ${endpoint.key}`}
                            onClick={() =>
                              setEndpoints(values.endpoints.filter((_, i) => i !== index))
                            }
                          >
                            <IconTrash size={16} />
                          </ActionIcon>
                        </Group>
                      </Group>
                      {kinds.length > 1 && (
                        <SegmentedControl
                          value={kind}
                          onChange={(next) => {
                            if (isEndpointKind(next)) {
                              setKind(index, next);
                            }
                          }}
                          data={kinds.map((k) => ({ value: k, label: KIND[k].label }))}
                        />
                      )}
                      <ProviderConfigForm
                        label={KIND[kind].form}
                        providers={choices[kind]}
                        type={ref.type}
                        config={ref.config}
                        configIssues={issuesAt(errors, `${path}.config`)}
                        onTypeChange={(type) => form.setFieldValue(path, { type, config: {} })}
                        onConfigChange={(config) => form.setFieldValue(`${path}.config`, config)}
                      />
                    </Stack>
                  </Accordion.Panel>
                </Accordion.Item>
              );
            })}
          </Accordion>
        )}
        <Group>
          <Button
            variant="light"
            leftIcon={<IconPlus size={16} />}
            disabled={kinds.length === 0}
            onClick={() =>
              setEndpoints([
                ...values.endpoints,
                blankEndpoint({ key: '', name: '', description: '' }, kinds[0] ?? 'target'),
              ])
            }
          >
            Add endpoint
          </Button>
        </Group>
        {typeof errors['endpoints'] === 'string' && (
          <Alert color="red" icon={<IconAlertCircle size={18} />}>
            {errors['endpoints']}
          </Alert>
        )}
      </Section>
    </Stack>
  );
}
