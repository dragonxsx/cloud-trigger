import { Accordion, ActionIcon, Button, Group, Menu, Stack, Text } from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { type ReactNode, useState } from 'react';

import { confirmAction } from '../../components/confirm';
import { asOverrides } from '../../components/ConnectedProviderPicker';
import { EnvironmentSelect } from '../../components/EnvironmentSelect';
import { ProviderConfigForm } from '../../components/ProviderConfigForm';
import type { ProviderDto } from '../../lib/api';
import { environmentLabel, useEnvironments } from '../../lib/environments';
import type { ConfigIssueDto } from '../../lib/errors';
import { countValues, fieldCount, hasValue } from './summary';

export interface EndpointOverlayValues {
  key: string;
  config: unknown;
}

export interface OverlayValues {
  environment: string;
  config?: unknown;
  endpoints: EndpointOverlayValues[];
}

export interface OverlayEndpoint {
  readonly key: string;
  readonly name: string;
  readonly provider: ProviderDto | undefined;
  readonly type: string;
  readonly config: unknown;
}

const isEmptyPatch = (config: unknown): boolean => !hasValue(config);

const withEndpointPatch = (
  overlay: OverlayValues,
  key: string,
  config: unknown,
): EndpointOverlayValues[] => {
  const rest = overlay.endpoints.filter((patch) => patch.key !== key);
  if (isEmptyPatch(config)) {
    return rest;
  }
  const index = overlay.endpoints.findIndex((patch) => patch.key === key);
  const next = { key, config };

  return index === -1
    ? [...rest, next]
    : overlay.endpoints.map((patch, i) => (i === index ? next : patch));
};

const overriddenFields = (overlay: OverlayValues): number =>
  countValues(overlay.config) +
  overlay.endpoints.reduce((total, patch) => total + countValues(patch.config), 0);

const overrideLabel = (count: number, none: string): string =>
  count === 0 ? none : `${fieldCount(count)} overridden`;

const itemValue = (overlay: OverlayValues, index: number): string =>
  overlay.environment === '' ? `new-${String(index)}` : overlay.environment;

function EndpointOverrides({
  overlay,
  at,
  endpoints,
  issuesAt,
  onChange,
}: {
  overlay: OverlayValues;
  at: string;
  endpoints: readonly OverlayEndpoint[];
  issuesAt: (prefix: string) => ConfigIssueDto[];
  onChange: (next: OverlayValues) => void;
}) {
  const [open, setOpen] = useState<string[]>([]);
  if (endpoints.length === 0) {
    return null;
  }

  return (
    <Stack spacing={4}>
      <Text size="sm" weight={600}>
        Endpoint overrides
      </Text>
      <Text size="xs" color="dimmed">
        Open an endpoint to change it in this environment. The rest keep their base settings.
      </Text>
      <Accordion variant="contained" multiple value={open} onChange={setOpen}>
        {endpoints.map((endpoint) => {
          const patchIndex = overlay.endpoints.findIndex((patch) => patch.key === endpoint.key);
          const patch = overlay.endpoints[patchIndex]?.config;
          const issues =
            patchIndex === -1 ? [] : issuesAt(`${at}.endpoints.${String(patchIndex)}.config`);

          return (
            <Accordion.Item key={endpoint.key} value={endpoint.key}>
              <Accordion.Control>
                <Text size="sm" weight={600}>
                  {endpoint.name || endpoint.key}
                  <Text span color="dimmed" weight={400} ml="xs">
                    {endpoint.type} · {overrideLabel(countValues(patch), 'uses base')}
                  </Text>
                  {issues.length > 0 && (
                    <Text span color="red" weight={400} ml="xs">
                      Needs attention
                    </Text>
                  )}
                </Text>
              </Accordion.Control>
              <Accordion.Panel>
                {open.includes(endpoint.key) && (
                  <ProviderConfigForm
                    label="Endpoint"
                    typeLocked
                    providers={endpoint.provider ? [asOverrides(endpoint.provider)] : []}
                    type={endpoint.type}
                    config={patch ?? {}}
                    inherited={endpoint.config}
                    configIssues={issues}
                    onTypeChange={() => undefined}
                    onConfigChange={(config) =>
                      onChange({
                        ...overlay,
                        endpoints: withEndpointPatch(overlay, endpoint.key, config),
                      })
                    }
                  />
                )}
              </Accordion.Panel>
            </Accordion.Item>
          );
        })}
      </Accordion>
    </Stack>
  );
}

export function OverlaysSection({
  overlays,
  connectionProvider,
  baseConfig,
  endpoints,
  issuesAt,
  onChange,
  renderTest,
}: {
  overlays: OverlayValues[];
  connectionProvider: ProviderDto | undefined;
  baseConfig: unknown;
  endpoints: readonly OverlayEndpoint[];
  issuesAt: (prefix: string) => ConfigIssueDto[];
  onChange: (overlays: OverlayValues[]) => void;
  renderTest: (overlay: OverlayValues) => ReactNode;
}) {
  const environments = useEnvironments();
  const [open, setOpen] = useState<string[]>([]);
  const used = overlays.map((overlay) => overlay.environment);
  const free = (environments.data ?? []).filter((environment) => !used.includes(environment.key));
  const connectionPatch = connectionProvider ? [asOverrides(connectionProvider)] : [];
  const update = (index: number, next: OverlayValues) =>
    onChange(overlays.map((overlay, i) => (i === index ? next : overlay)));
  const labelOf = (key: string) => {
    const found = environments.data?.find((environment) => environment.key === key);

    return found ? environmentLabel(found) : key || 'New overlay';
  };
  const add = (environment: string) => {
    onChange([...overlays, { environment, endpoints: [] }]);
    setOpen((current) => [...current, environment]);
  };
  const remove = (index: number) => {
    const overlay = overlays[index];
    if (!overlay) {
      return;
    }
    const drop = () => {
      onChange(overlays.filter((_, i) => i !== index));
      setOpen((current) => current.filter((value) => value !== itemValue(overlay, index)));
    };
    const count = overriddenFields(overlay);
    if (count === 0) {
      drop();

      return;
    }
    void confirmAction({
      title: `Remove the ${labelOf(overlay.environment)} overlay?`,
      message: `Its ${fieldCount(count)} of overrides are removed from the form. Jobs in this environment use the base config once you save the connection.`,
      confirmLabel: 'Remove overlay',
      onConfirm: drop,
    });
  };

  return (
    <Stack spacing="sm">
      {overlays.length === 0 ? (
        <Text size="sm" color="dimmed">
          No overlays. Every environment uses the base config above.
        </Text>
      ) : (
        <Accordion variant="separated" multiple value={open} onChange={setOpen}>
          {overlays.map((overlay, index) => {
            const at = `overlays.${String(index)}`;
            const value = itemValue(overlay, index);
            const label = labelOf(overlay.environment);
            const invalid = issuesAt(`${at}.`).length > 0;

            return (
              <Accordion.Item key={value} value={value}>
                <Group spacing={4} noWrap pr="sm">
                  <Accordion.Control style={{ flex: 1, minWidth: 0 }}>
                    <Text size="sm" weight={600}>
                      {label}
                      <Text span color="dimmed" weight={400} ml="xs">
                        {overrideLabel(overriddenFields(overlay), 'no overrides')}
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
                    aria-label={`Remove ${label} overlay`}
                    onClick={() => remove(index)}
                  >
                    <IconTrash size={16} />
                  </ActionIcon>
                </Group>
                <Accordion.Panel>
                  {open.includes(value) && (
                    <Stack spacing="md">
                      <EnvironmentSelect
                        placeholder="Pick an environment"
                        value={overlay.environment || null}
                        clearable={false}
                        exclude={used}
                        onChange={(environment) => {
                          const next = environment ?? '';
                          update(index, { ...overlay, environment: next });
                          setOpen((current) =>
                            current.map((item) =>
                              item === value
                                ? itemValue({ ...overlay, environment: next }, index)
                                : item,
                            ),
                          );
                        }}
                        error={issuesAt(`${at}.environment`)[0]?.message}
                      />
                      <Stack spacing={4}>
                        <Text size="sm" weight={600}>
                          Address and credentials
                        </Text>
                        <Text size="xs" color="dimmed">
                          Only the fields you fill in replace the base config.
                        </Text>
                        <ProviderConfigForm
                          label="Type"
                          typeLocked
                          providers={connectionPatch}
                          type={connectionProvider?.type ?? ''}
                          config={overlay.config ?? {}}
                          inherited={baseConfig}
                          configIssues={issuesAt(`${at}.config`)}
                          onTypeChange={() => undefined}
                          onConfigChange={(config) =>
                            update(index, {
                              ...overlay,
                              ...(isEmptyPatch(config) ? { config: undefined } : { config }),
                            })
                          }
                        />
                        {renderTest(overlay)}
                      </Stack>
                      <EndpointOverrides
                        overlay={overlay}
                        at={at}
                        endpoints={endpoints}
                        issuesAt={issuesAt}
                        onChange={(next) => update(index, next)}
                      />
                      {overlay.endpoints.map((patch, patchIndex) =>
                        endpoints.some((endpoint) => endpoint.key === patch.key) ? null : (
                          <Group key={`orphan-${String(patchIndex)}`} position="apart" noWrap>
                            <Stack spacing={0}>
                              <Text size="sm" weight={600}>
                                Override for missing endpoint &ldquo;{patch.key}&rdquo;
                              </Text>
                              <Text size="xs" color="red">
                                {issuesAt(`${at}.endpoints.${String(patchIndex)}.key`)[0]
                                  ?.message ??
                                  'Its endpoint was removed or renamed. Remove the override to save.'}
                              </Text>
                            </Stack>
                            <ActionIcon
                              color="red"
                              variant="subtle"
                              aria-label={`Remove override for ${patch.key}`}
                              onClick={() =>
                                update(index, {
                                  ...overlay,
                                  endpoints: overlay.endpoints.filter((_, i) => i !== patchIndex),
                                })
                              }
                            >
                              <IconTrash size={16} />
                            </ActionIcon>
                          </Group>
                        ),
                      )}
                    </Stack>
                  )}
                </Accordion.Panel>
              </Accordion.Item>
            );
          })}
        </Accordion>
      )}
      <Group>
        <Menu position="bottom-start" withinPortal>
          <Menu.Target>
            <Button variant="light" leftIcon={<IconPlus size={16} />} disabled={free.length === 0}>
              Add overlay
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>Override settings for</Menu.Label>
            {free.map((environment) => (
              <Menu.Item key={environment.key} onClick={() => add(environment.key)}>
                {environmentLabel(environment)}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
        {environments.data?.length === 0 && (
          <Text size="sm" color="dimmed">
            Add environments in Settings → Environments first.
          </Text>
        )}
        {environments.data !== undefined && environments.data.length > 0 && free.length === 0 && (
          <Text size="sm" color="dimmed">
            Every environment already has an overlay.
          </Text>
        )}
      </Group>
    </Stack>
  );
}
