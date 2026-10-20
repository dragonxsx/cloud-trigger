import { isRecord } from '@cloud-trigger/core';
import { Accordion, ActionIcon, Button, Group, Stack, Text } from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import type { ReactNode } from 'react';

import { asOverrides } from '../../components/ConnectedProviderPicker';
import { EnvironmentSelect } from '../../components/EnvironmentSelect';
import { ProviderConfigForm } from '../../components/ProviderConfigForm';
import type { ProviderDto } from '../../lib/api';
import { environmentLabel, useEnvironments } from '../../lib/environments';
import type { ConfigIssueDto } from '../../lib/errors';

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
}

const isEmptyPatch = (config: unknown): boolean =>
  config === undefined || (isRecord(config) && Object.keys(config).length === 0);

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

export function OverlaysSection({
  overlays,
  connectionProvider,
  endpoints,
  issuesAt,
  onChange,
  renderTest,
}: {
  overlays: OverlayValues[];
  connectionProvider: ProviderDto | undefined;
  endpoints: readonly OverlayEndpoint[];
  issuesAt: (prefix: string) => ConfigIssueDto[];
  onChange: (overlays: OverlayValues[]) => void;
  renderTest: (overlay: OverlayValues) => ReactNode;
}) {
  const environments = useEnvironments();
  const used = overlays.map((overlay) => overlay.environment);
  const free = (environments.data ?? []).filter((environment) => !used.includes(environment.key));
  const connectionPatch = connectionProvider ? [asOverrides(connectionProvider)] : [];
  const update = (index: number, next: OverlayValues) =>
    onChange(overlays.map((overlay, i) => (i === index ? next : overlay)));
  const labelOf = (key: string) => {
    const found = environments.data?.find((environment) => environment.key === key);

    return found ? environmentLabel(found) : key || 'New overlay';
  };

  return (
    <Stack spacing="sm">
      {overlays.length === 0 ? (
        <Text size="sm" color="dimmed">
          No overlays. Every environment uses the base config above.
        </Text>
      ) : (
        <Accordion variant="separated" multiple>
          {overlays.map((overlay, index) => {
            const at = `overlays.${index}`;
            const overridden = overlay.endpoints.length + (isEmptyPatch(overlay.config) ? 0 : 1);

            return (
              <Accordion.Item key={index} value={String(index)}>
                <Accordion.Control>
                  <Text size="sm" weight={600}>
                    {labelOf(overlay.environment)}
                    <Text span color="dimmed" weight={400} ml="xs">
                      {overridden === 0
                        ? 'no overrides'
                        : `${overridden} override${overridden === 1 ? '' : 's'}`}
                    </Text>
                  </Text>
                </Accordion.Control>
                <Accordion.Panel>
                  <Stack spacing="md">
                    <Group align="flex-end" grow>
                      <EnvironmentSelect
                        placeholder="Pick an environment"
                        value={overlay.environment || null}
                        clearable={false}
                        exclude={used}
                        onChange={(environment) =>
                          update(index, { ...overlay, environment: environment ?? '' })
                        }
                        error={issuesAt(`${at}.environment`)[0]?.message}
                      />
                      <Group position="right" style={{ flexGrow: 0 }}>
                        <ActionIcon
                          color="red"
                          variant="subtle"
                          aria-label={`Remove ${overlay.environment} overlay`}
                          onClick={() => onChange(overlays.filter((_, i) => i !== index))}
                        >
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Group>
                    </Group>
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
                    {endpoints.map((endpoint) => {
                      const patchIndex = overlay.endpoints.findIndex(
                        (patch) => patch.key === endpoint.key,
                      );

                      return (
                        <Stack key={endpoint.key} spacing={4}>
                          <Text size="sm" weight={600}>
                            {endpoint.name || endpoint.key}
                            <Text span color="dimmed" weight={400} ml="xs">
                              {endpoint.type}
                            </Text>
                          </Text>
                          <ProviderConfigForm
                            label="Endpoint"
                            typeLocked
                            providers={endpoint.provider ? [asOverrides(endpoint.provider)] : []}
                            type={endpoint.type}
                            config={overlay.endpoints[patchIndex]?.config ?? {}}
                            configIssues={
                              patchIndex === -1
                                ? []
                                : issuesAt(`${at}.endpoints.${patchIndex}.config`)
                            }
                            onTypeChange={() => undefined}
                            onConfigChange={(config) =>
                              update(index, {
                                ...overlay,
                                endpoints: withEndpointPatch(overlay, endpoint.key, config),
                              })
                            }
                          />
                        </Stack>
                      );
                    })}
                    {overlay.endpoints.map((patch, patchIndex) =>
                      endpoints.some((endpoint) => endpoint.key === patch.key) ? null : (
                        <Group key={`orphan-${patchIndex}`} position="apart" noWrap>
                          <Stack spacing={0}>
                            <Text size="sm" weight={600}>
                              Override for missing endpoint "{patch.key}"
                            </Text>
                            <Text size="xs" color="red">
                              {issuesAt(`${at}.endpoints.${patchIndex}.key`)[0]?.message ??
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
          disabled={free.length === 0}
          onClick={() =>
            onChange([...overlays, { environment: free[0]?.key ?? '', endpoints: [] }])
          }
        >
          Add overlay
        </Button>
        {environments.data?.length === 0 && (
          <Text size="sm" color="dimmed">
            Add environments in Settings → Environments first.
          </Text>
        )}
      </Group>
    </Stack>
  );
}
