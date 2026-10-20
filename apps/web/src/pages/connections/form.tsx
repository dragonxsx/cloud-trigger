import { type EndpointKind, endpointProvider } from '@cloud-trigger/core';
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
  | (EndpointFields & { source: ProviderRefValues });

const KIND_FIELD: Record<EndpointKind, 'target' | 'source'> = {
  target: 'target',
  trigger: 'source',
};

const endpointOf = (
  fields: EndpointFields,
  kind: EndpointKind,
  ref: ProviderRefValues,
): EndpointValues => (kind === 'target' ? { ...fields, target: ref } : { ...fields, source: ref });

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

    return { target: over('target'), trigger: over('trigger') };
  }, [providers.data, form.values.type]);
  const { values, errors } = form;
  const setEndpoints = (endpoints: EndpointValues[]) => form.setFieldValue('endpoints', endpoints);
  const kinds = (['target', 'trigger'] as const).filter((kind) => choices[kind].length > 0);
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
        hint="Saved requests and event sources that jobs pick by name. A job can still override any field."
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
              const path = `endpoints.${index}.${KIND_FIELD[kind]}`;
              const base = `endpoints.${index}`;

              return (
                <Accordion.Item key={index} value={String(index)}>
                  <Accordion.Control>
                    <Text size="sm" weight={600}>
                      {endpoint.name || endpoint.key || 'New endpoint'}
                      <Text span color="dimmed" weight={400} ml="xs">
                        {kind === 'target' ? ref.type : `${ref.type} source`}
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
                          onChange={(next) =>
                            setKind(index, next === 'trigger' ? 'trigger' : 'target')
                          }
                          data={[
                            { value: 'target', label: 'Target' },
                            { value: 'trigger', label: 'Event source' },
                          ]}
                        />
                      )}
                      <ProviderConfigForm
                        label={kind === 'target' ? 'Request' : 'Event source'}
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
