import {
  Accordion,
  ActionIcon,
  Alert,
  Button,
  Group,
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

import { ProviderConfigForm } from '../../components/ProviderConfigForm';
import { forConnection } from '../../components/TargetPicker';
import { type ConnectionSpecDto, client } from '../../lib/api';
import type { ConfigIssueDto } from '../../lib/errors';
import { errorMessage } from '../../lib/errors';

interface EndpointValues {
  key: string;
  name: string;
  description: string;
  target: { type: string; config: unknown };
}

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
  const targets = useMemo(
    () =>
      (providers.data ?? [])
        .filter((p) => p.kind === 'target' && p.connectionType === form.values.type)
        .map(forConnection),
    [providers.data, form.values.type],
  );
  const { values, errors } = form;
  const setEndpoints = (endpoints: EndpointValues[]) => form.setFieldValue('endpoints', endpoints);

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
        hint="Saved requests that jobs pick by name. A job can still override any field."
      >
        {values.endpoints.length === 0 ? (
          <Text size="sm" color="dimmed">
            No endpoints yet. Jobs can still use the connection and configure the request
            themselves.
          </Text>
        ) : (
          <Accordion variant="separated" multiple>
            {values.endpoints.map((endpoint, index) => {
              const path = `endpoints.${index}`;

              return (
                <Accordion.Item key={index} value={String(index)}>
                  <Accordion.Control>
                    <Text size="sm" weight={600}>
                      {endpoint.name || endpoint.key || 'New endpoint'}
                      <Text span color="dimmed" weight={400} ml="xs">
                        {endpoint.target.type}
                      </Text>
                    </Text>
                  </Accordion.Control>
                  <Accordion.Panel>
                    <Stack spacing="sm">
                      <Group align="flex-end" grow>
                        <TextInput label="Key" required {...form.getInputProps(`${path}.key`)} />
                        <TextInput label="Display name" {...form.getInputProps(`${path}.name`)} />
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
                      <ProviderConfigForm
                        label="Request"
                        providers={targets}
                        type={endpoint.target.type}
                        config={endpoint.target.config}
                        configIssues={issuesAt(errors, `${path}.target.config`)}
                        onTypeChange={(type) =>
                          form.setFieldValue(`${path}.target`, { type, config: {} })
                        }
                        onConfigChange={(config) =>
                          form.setFieldValue(`${path}.target.config`, config)
                        }
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
            disabled={targets.length === 0}
            onClick={() =>
              setEndpoints([
                ...values.endpoints,
                {
                  key: '',
                  name: '',
                  description: '',
                  target: { type: targets[0]?.type ?? '', config: {} },
                },
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
