import {
  ConnectionKey,
  EndpointKey,
  type EndpointKind,
  assertNever,
  endpointProvider,
  isRecord,
  mergePatch,
  slugKey,
} from '@cloud-trigger/core';
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
import { showNotification } from '@mantine/notifications';
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconCircleCheck,
  IconFileImport,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type ReactNode, useMemo, useRef, useState } from 'react';

import { confirmAction } from '../../components/confirm';
import { forConnection } from '../../components/ConnectedProviderPicker';
import { OpenApiImportModal, type OpenApiImportResult } from '../../components/OpenApiImportModal';
import { ProviderConfigForm } from '../../components/ProviderConfigForm';
import { useHasScope } from '../../lib/access';
import { type ConnectionSpecDto, client } from '../../lib/api';
import type { ConfigIssueDto } from '../../lib/errors';
import { errorMessage } from '../../lib/errors';
import { type OverlayEndpoint, type OverlayValues, OverlaysSection } from './overlays';
import { type TestTone, connectionAddress, describeTest, hasValue } from './summary';

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
  overlays: OverlayValues[];
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
  overlays: [],
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
  overlays: v.overlays,
  ...(version !== undefined && { expectedVersion: version }),
});

const keyError = (schema: typeof ConnectionKey, value: string): string | null => {
  const trimmed = value.trim();
  if (trimmed === '') {
    return 'Required';
  }
  const parsed = schema.safeParse(trimmed);

  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Not a valid key');
};

export const validateConnection = (values: ConnectionFormValues): Record<string, string | null> => {
  const errors: Record<string, string | null> = { key: keyError(ConnectionKey, values.key) };
  values.endpoints.forEach((endpoint, index) => {
    const duplicate = values.endpoints.some(
      (other, i) => i < index && other.key !== '' && other.key === endpoint.key,
    );
    errors[`endpoints.${String(index)}.key`] = duplicate
      ? 'Another endpoint already uses this key'
      : keyError(EndpointKey, endpoint.key);
  });
  values.overlays.forEach((overlay, index) => {
    errors[`overlays.${String(index)}.environment`] =
      overlay.environment === '' ? 'Pick an environment' : null;
  });

  return errors;
};

/** Overlay endpoint patches follow their endpoint's key; `to: null` drops them with it. */
const movePatches = (overlays: OverlayValues[], from: string, to: string | null): OverlayValues[] =>
  overlays.map((overlay) => ({
    ...overlay,
    endpoints: overlay.endpoints.flatMap((patch) =>
      patch.key !== from ? [patch] : to === null ? [] : [{ ...patch, key: to }],
    ),
  }));

interface StashedType {
  readonly config: unknown;
  readonly endpoints: EndpointValues[];
  readonly overlays: OverlayValues[];
}

const issuesAt = (errors: Record<string, ReactNode>, prefix: string): ConfigIssueDto[] =>
  Object.entries(errors).flatMap(([path, message]) =>
    path.startsWith(prefix) && typeof message === 'string'
      ? [{ path: path.slice(prefix.length).replace(/^\./, ''), message }]
      : [],
  );

const FOCUS_AFTER_REMOVE_MS = 50;

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

const TONE: Record<TestTone, { color: string; icon: ReactNode }> = {
  ok: { color: 'teal', icon: <IconCircleCheck size={18} /> },
  warn: { color: 'yellow', icon: <IconAlertTriangle size={18} /> },
  fail: { color: 'red', icon: <IconAlertCircle size={18} /> },
};

function TestResult({ tone, message }: { tone: TestTone; message: string }) {
  return (
    <Alert color={TONE[tone].color} icon={TONE[tone].icon}>
      {message}
    </Alert>
  );
}

const focusOnMount = (input: HTMLInputElement | null): void => {
  input?.focus();
};

const plural = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? '' : 's'}`;

export function ConnectionTestButton({
  type,
  config,
  savedKey,
  overlay,
  label = 'Test connection',
}: {
  type: string;
  config: unknown;
  savedKey?: string | undefined;
  overlay?: { environment: string; config: unknown } | undefined;
  label?: string;
}) {
  const canWrite = useHasScope('write');
  const snapshot = JSON.stringify({ type, config, overlay });
  const test = useMutation({
    mutationFn: (_tested: string) =>
      client.connections.test({
        type,
        config,
        ...(savedKey !== undefined && { key: savedKey }),
        ...(overlay !== undefined && { overlay }),
      }),
  });
  const stale = test.variables !== undefined && test.variables !== snapshot;
  const address = connectionAddress({
    config:
      overlay === undefined || !isRecord(overlay.config)
        ? config
        : mergePatch(config, overlay.config),
  });
  const view = test.data ? describeTest(test.data, address) : undefined;

  return (
    <Stack spacing="xs">
      <Group spacing="sm">
        <Button
          variant="default"
          loading={test.isPending}
          disabled={canWrite === false}
          onClick={() => test.mutate(snapshot)}
        >
          {label}
        </Button>
        {canWrite === false && (
          <Text size="sm" color="dimmed">
            Testing needs the write scope.
          </Text>
        )}
        {stale && !test.isPending && (
          <Text size="sm" color="dimmed">
            Settings changed since the last test. Test again to check them.
          </Text>
        )}
      </Group>
      {!stale && view && <TestResult tone={view.tone} message={view.message} />}
      {!stale && test.isError && <TestResult tone="fail" message={errorMessage(test.error)} />}
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
  const [importing, setImporting] = useState(false);
  const [openEndpoints, setOpenEndpoints] = useState<string[]>([]);
  const [focusEndpoint, setFocusEndpoint] = useState<string | null>(null);
  const [endpointIds, setEndpointIds] = useState<readonly string[]>([]);
  const createdIds = useRef(0);
  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  const addEndpointButton = useRef<HTMLButtonElement>(null);
  const newEndpointId = () => {
    createdIds.current += 1;

    return `added-${String(createdIds.current)}`;
  };
  const ids = values.endpoints.map((_, i) => endpointIds[i] ?? `loaded-${String(i)}`);
  const resetEndpointIds = (count: number) =>
    setEndpointIds(Array.from({ length: count }, () => newEndpointId()));
  const [stash, setStash] = useState<ReadonlyMap<string, StashedType>>(new Map());
  const invalidEndpoints = Object.keys(errors).flatMap((path) => {
    const index = /^endpoints\.(\d+)\./.exec(path)?.[1];
    const id = index === undefined ? undefined : ids[Number(index)];

    return id === undefined ? [] : [id];
  });
  const shownEndpoints = [...new Set([...openEndpoints, ...invalidEndpoints])];
  const connectionConfig = isRecord(values.config) ? values.config : {};
  const baseUrl =
    typeof connectionConfig['baseUrl'] === 'string' ? connectionConfig['baseUrl'] : undefined;
  const applyImport = (result: OpenApiImportResult) => {
    form.setFieldValue('endpoints', [...result.endpoints]);
    resetEndpointIds(result.endpoints.length);
    setOpenEndpoints([]);
    if (result.baseUrl !== undefined || result.auth !== undefined) {
      form.setFieldValue('config', {
        ...connectionConfig,
        ...(result.baseUrl !== undefined && { baseUrl: result.baseUrl }),
        ...(result.auth !== undefined && { auth: result.auth }),
      });
    }
    if (!editing && values.key === '' && result.title !== '') {
      form.setFieldValue('key', slugKey(result.title, ''));
    }
    if (values.name === '' && result.title !== '') {
      form.setFieldValue('name', result.title);
    }
    showNotification({
      color: 'green',
      title: 'Endpoints imported into the form',
      message: `${result.added} added, ${result.updated} updated. Save the connection to keep them.`,
    });
  };
  const setEndpoints = (endpoints: EndpointValues[]) => form.setFieldValue('endpoints', endpoints);
  // Patches stay put while another endpoint still has the old key or already has the new one.
  const moveEndpoint = (index: number, to: string | null) => {
    const from = values.endpoints[index]?.key ?? '';
    const shared = values.endpoints.some(
      (endpoint, i) => i !== index && (endpoint.key === from || endpoint.key === to),
    );
    if (!shared) {
      form.setFieldValue('overlays', movePatches(values.overlays, from, to));
    }
  };
  const overlayEndpoints: OverlayEndpoint[] = values.endpoints.flatMap((endpoint) => {
    const { kind, ref } = endpointProvider(endpoint);

    return endpoint.key
      ? [
          {
            key: endpoint.key,
            name: endpoint.name,
            type: ref.type,
            config: ref.config,
            provider: choices[kind].find((p) => p.type === ref.type),
          },
        ]
      : [];
  });
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

  const switchType = (type: string) => {
    const restored = stash.get(type);
    setStash(
      new Map(stash).set(values.type, {
        config: values.config,
        endpoints: values.endpoints,
        overlays: values.overlays,
      }),
    );
    form.setFieldValue('type', type);
    form.setFieldValue('config', restored?.config ?? {});
    setEndpoints(restored?.endpoints ?? []);
    resetEndpointIds(restored?.endpoints.length ?? 0);
    form.setFieldValue('overlays', restored?.overlays ?? []);
    setOpenEndpoints([]);
  };
  const changeType = (type: string) => {
    const lost = [
      ...(values.endpoints.length > 0 ? [plural(values.endpoints.length, 'endpoint')] : []),
      ...(values.overlays.length > 0 ? [plural(values.overlays.length, 'overlay')] : []),
    ];
    if (lost.length === 0) {
      switchType(type);

      return;
    }
    const name = connectionTypes.find((p) => p.type === type)?.displayName ?? type;
    void confirmAction({
      title: `Switch to ${name}?`,
      message: `Endpoints and overlays belong to one connection type, so this clears ${lost.join(' and ')} from the form. Switch back before saving to get them back.`,
      confirmLabel: 'Switch type',
      onConfirm: () => switchType(type),
    });
  };
  const removeEndpoint = (index: number) => {
    moveEndpoint(index, null);
    const removed = ids[index];
    const neighbour = ids[index + 1] ?? ids[index - 1];
    window.setTimeout(() => {
      const target =
        (neighbour === undefined ? undefined : removeButtons.current.get(neighbour)) ??
        addEndpointButton.current;
      target?.focus();
    }, FOCUS_AFTER_REMOVE_MS);
    setEndpoints(values.endpoints.filter((_, i) => i !== index));
    setEndpointIds(ids.filter((_, i) => i !== index));
    setOpenEndpoints((open) => open.filter((id) => id !== removed));
    setFocusEndpoint((focused) => (focused === removed ? null : focused));
  };
  const confirmRemoveEndpoint = (index: number) => {
    const endpoint = values.endpoints[index];
    if (!endpoint) {
      return;
    }
    const { ref } = endpointProvider(endpoint);
    const blank =
      endpoint.key === '' &&
      endpoint.name === '' &&
      endpoint.description === '' &&
      !hasValue(ref.config);
    if (blank) {
      removeEndpoint(index);

      return;
    }
    const shared = values.endpoints.some((other, i) => i !== index && other.key === endpoint.key);
    const patched = shared
      ? 0
      : values.overlays.filter((overlay) =>
          overlay.endpoints.some((patch) => patch.key === endpoint.key),
        ).length;
    const label = endpoint.name || endpoint.key || 'this endpoint';
    void confirmAction({
      title: `Remove ${label}?`,
      message: `${patched > 0 ? `Its overrides in ${plural(patched, 'overlay')} go too. ` : ''}Jobs that pick this endpoint stop working once you save the connection.`,
      confirmLabel: 'Remove endpoint',
      onConfirm: () => removeEndpoint(index),
    });
  };
  const addEndpoint = () => {
    const id = newEndpointId();
    setEndpoints([
      ...values.endpoints,
      blankEndpoint({ key: '', name: '', description: '' }, kinds[0] ?? 'target'),
    ]);
    setEndpointIds([...ids, id]);
    setOpenEndpoints((open) => [...open, id]);
    setFocusEndpoint(id);
  };

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
          onTypeChange={changeType}
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
            {values.type === 'http' && ' Have an OpenAPI document? Import its operations below.'}
          </Text>
        ) : (
          <Accordion
            variant="separated"
            multiple
            value={shownEndpoints}
            onChange={(open) => {
              setOpenEndpoints(open);
              setFocusEndpoint(null);
            }}
          >
            {values.endpoints.map((endpoint, index) => {
              const { kind, ref } = endpointProvider(endpoint);
              const path = `endpoints.${index}.${KIND[kind].field}`;
              const base = `endpoints.${index}`;
              const id = ids[index] ?? `loaded-${String(index)}`;
              const open = shownEndpoints.includes(id);
              const invalid = Object.keys(errors).some((key) => key.startsWith(`${base}.`));
              const label = endpoint.name || endpoint.key || 'New endpoint';

              return (
                <Accordion.Item key={id} value={id}>
                  <Group spacing={4} noWrap pr="sm">
                    <Accordion.Control style={{ flex: 1, minWidth: 0 }}>
                      <Text size="sm" weight={600}>
                        {label}
                        <Text span color="dimmed" weight={400} ml="xs">
                          {ref.type}
                          {KIND[kind].suffix}
                        </Text>
                        {invalid && (
                          <Text span color="red" weight={400} ml="xs">
                            Needs attention
                          </Text>
                        )}
                      </Text>
                    </Accordion.Control>
                    <ActionIcon
                      color="red"
                      variant="subtle"
                      size="lg"
                      aria-label={`Remove endpoint ${label}`}
                      ref={(node) => {
                        if (node === null) {
                          removeButtons.current.delete(id);
                        } else {
                          removeButtons.current.set(id, node);
                        }
                      }}
                      onClick={() => confirmRemoveEndpoint(index)}
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Group>
                  <Accordion.Panel>
                    {open && (
                      <Stack spacing="sm">
                        <SimpleGrid cols={2} breakpoints={[{ maxWidth: 'sm', cols: 1 }]}>
                          <TextInput
                            label="Key"
                            required
                            autoComplete="off"
                            {...(focusEndpoint === id && { ref: focusOnMount })}
                            {...form.getInputProps(`${base}.key`)}
                            onChange={(event) => {
                              moveEndpoint(index, event.currentTarget.value);
                              form.setFieldValue(`${base}.key`, event.currentTarget.value);
                            }}
                          />
                          <TextInput
                            label="Display name"
                            autoComplete="off"
                            {...form.getInputProps(`${base}.name`)}
                          />
                        </SimpleGrid>
                        <Textarea
                          label="Description"
                          autosize
                          minRows={1}
                          maxRows={6}
                          {...form.getInputProps(`${base}.description`)}
                        />
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
                    )}
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
            ref={addEndpointButton}
            onClick={addEndpoint}
          >
            Add endpoint
          </Button>
          {values.type === 'http' && (
            <Button
              variant="default"
              leftIcon={<IconFileImport size={16} />}
              onClick={() => setImporting(true)}
            >
              Import from OpenAPI
            </Button>
          )}
        </Group>
        <OpenApiImportModal
          opened={importing}
          onClose={() => setImporting(false)}
          endpoints={values.endpoints}
          baseUrl={baseUrl}
          onApply={applyImport}
        />
        {typeof errors['endpoints'] === 'string' && (
          <Alert color="red" icon={<IconAlertCircle size={18} />}>
            {errors['endpoints']}
          </Alert>
        )}
      </Section>

      <Section
        title="Environment overlays"
        hint="Per-environment overrides of the address, credentials and endpoints. Jobs in an environment without an overlay use the base config."
      >
        <OverlaysSection
          overlays={values.overlays}
          connectionProvider={connectionTypes.find((p) => p.type === values.type)}
          baseConfig={values.config}
          endpoints={overlayEndpoints}
          issuesAt={(prefix) => issuesAt(errors, prefix)}
          onChange={(overlays) => form.setFieldValue('overlays', overlays)}
          renderTest={(overlay) =>
            overlay.environment ? (
              <ConnectionTestButton
                type={values.type}
                config={values.config}
                savedKey={editing ? values.key : undefined}
                overlay={{ environment: overlay.environment, config: overlay.config ?? {} }}
              />
            ) : null
          }
        />
      </Section>
    </Stack>
  );
}
