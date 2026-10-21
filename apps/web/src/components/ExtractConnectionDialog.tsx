import {
  Alert,
  Anchor,
  Button,
  Code,
  Group,
  List,
  Modal,
  Select,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { useInvalidate } from '@refinedev/core';
import { IconPlugConnected } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';

import { type ExtractSlotDto, type JobDto, type ProviderDto, client } from '../lib/api';
import { configIssues, errorMessage, notifyError } from '../lib/errors';

interface SlotOption {
  readonly value: string;
  readonly label: string;
  readonly slot: ExtractSlotDto;
  readonly connectionType: string | undefined;
}

interface SlotRef {
  readonly type: string;
  readonly connection?: unknown;
}

const option = (
  providers: readonly ProviderDto[],
  kind: ProviderDto['kind'],
  ref: SlotRef,
  value: string,
  label: string,
  slot: ExtractSlotDto,
): SlotOption[] => {
  const provider = providers.find((p) => p.kind === kind && p.type === ref.type);

  return provider?.extractsConnection === true && ref.connection === undefined
    ? [{ value, label: `${label} (${ref.type})`, slot, connectionType: provider.connectionType }]
    : [];
};

export const extractableSlots = (
  job: JobDto,
  providers: readonly ProviderDto[],
): readonly SlotOption[] => [
  ...option(providers, 'target', job.target, 'target', 'Target', { kind: 'target' }),
  ...option(providers, 'trigger', job.trigger, 'trigger', 'Trigger', { kind: 'trigger' }),
  ...job.notifications.flatMap((rule, index) =>
    option(
      providers,
      'notifier',
      rule.notifier,
      `notification:${index}`,
      `Notification ${index + 1}`,
      {
        kind: 'notification',
        index,
      },
    ),
  ),
];

const optional = (value: string): string | undefined =>
  value.trim() === '' ? undefined : value.trim();

export function ExtractConnectionDialog({ job }: { job: JobDto }) {
  const [opened, setOpened] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const invalidate = useInvalidate();
  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: () => client.providers.list({}),
    staleTime: 300_000,
  });
  const slots = useMemo(() => extractableSlots(job, providers.data ?? []), [job, providers.data]);
  const current = slots.find((s) => s.value === selected) ?? slots[0];
  const request = (dryRun: boolean, expectedVersion: number) => {
    if (!current) {
      throw new Error('Nothing on this job can move onto a connection');
    }

    return client.jobs.extractConnection({
      id: job.id,
      slot: current.slot,
      key: optional(key),
      name: optional(name),
      baseUrl: current.connectionType === 'http' ? optional(baseUrl) : undefined,
      expectedVersion,
      dryRun,
    });
  };
  const preview = useMutation({ mutationFn: () => request(true, job.version) });
  const confirm = useMutation({
    mutationFn: () => {
      if (!preview.data) {
        throw new Error('Preview the extraction first');
      }

      return request(false, preview.data.job.version);
    },
    onSuccess: async (result) => {
      showNotification({
        color: 'green',
        message: `Created connection "${result.connection.key}" and moved the job onto it`,
      });
      setOpened(false);
      preview.reset();
      await Promise.all([
        invalidate({ resource: 'jobs', invalidates: ['detail', 'list'], id: job.id }),
        invalidate({ resource: 'connections', invalidates: ['list'] }),
      ]);
    },
    onError: (e) => notifyError('Could not extract the connection', e),
  });
  const stale = preview.data !== undefined && preview.data.job.version !== job.version;
  const changed = (set: (value: string) => void) => (value: string) => {
    set(value);
    preview.reset();
  };
  const issues = configIssues(preview.error);
  const issueAt = (path: string) => issues.find((issue) => issue.path === path)?.message;

  if (slots.length === 0) {
    return null;
  }

  return (
    <>
      <Button
        variant="default"
        leftIcon={<IconPlugConnected size={16} />}
        onClick={() => setOpened(true)}
      >
        Extract connection
      </Button>
      <Modal
        opened={opened}
        onClose={() => setOpened(false)}
        title="Extract a connection"
        size="lg"
      >
        <Stack spacing="md">
          <Text size="sm" color="dimmed">
            Moves the address and credentials of an inline config onto a new connection with one
            endpoint, then points the job at it. The job keeps sending the same requests.
          </Text>
          <Select
            label="Move"
            data={slots.map((s) => ({ value: s.value, label: s.label }))}
            value={current?.value ?? null}
            onChange={(value) => {
              setSelected(value);
              preview.reset();
            }}
          />
          <Group grow>
            <TextInput
              label="Connection key"
              placeholder="From the host"
              value={key}
              error={issueAt('key')}
              onChange={(e) => changed(setKey)(e.currentTarget.value)}
            />
            <TextInput
              label="Name"
              placeholder="From the host"
              value={name}
              onChange={(e) => changed(setName)(e.currentTarget.value)}
            />
          </Group>
          {current?.connectionType === 'http' && (
            <TextInput
              label="Base URL"
              description="Part of the URL to keep on the connection. Defaults to the scheme and host."
              placeholder="https://api.example.com/v1"
              value={baseUrl}
              error={issueAt('baseUrl')}
              onChange={(e) => changed(setBaseUrl)(e.currentTarget.value)}
            />
          )}
          {preview.isError && (
            <Alert color="red">
              {issues.length > 0 ? (
                <List size="sm">
                  {issues.map((issue) => (
                    <List.Item key={`${issue.path}:${issue.message}`}>
                      {issue.path ? `${issue.path}: ` : ''}
                      {issue.message}
                    </List.Item>
                  ))}
                </List>
              ) : (
                errorMessage(preview.error)
              )}
            </Alert>
          )}
          {preview.data && (
            <Stack spacing="xs">
              <Text size="sm">
                Connection <Code>{preview.data.connection.key}</Code> with endpoint{' '}
                <Code>{preview.data.endpoint}</Code>
              </Text>
              <Code block>{JSON.stringify(preview.data.connection.config, null, 2)}</Code>
              {preview.data.warnings.length > 0 && (
                <Alert color="yellow" title="Check before saving">
                  <List size="sm">
                    {preview.data.warnings.map((w) => (
                      <List.Item key={`${w.path}:${w.message}`}>{w.message}</List.Item>
                    ))}
                  </List>
                </Alert>
              )}
              {preview.data.similar.length > 0 && (
                <Alert color="blue" title="Similar connections exist">
                  <List size="sm">
                    {preview.data.similar.map((s) => (
                      <List.Item key={s.key}>
                        <Anchor component={Link} to={`/connections/show/${s.key}`} size="sm">
                          {s.name || s.key}
                        </Anchor>{' '}
                        {s.match === 'identical'
                          ? 'has the same settings'
                          : 'uses the same address'}
                      </List.Item>
                    ))}
                  </List>
                </Alert>
              )}
            </Stack>
          )}
          {stale && (
            <Alert color="yellow">The job changed since the preview. Preview it again.</Alert>
          )}
          <Group position="right">
            <Button variant="default" loading={preview.isPending} onClick={() => preview.mutate()}>
              Preview
            </Button>
            <Button
              disabled={!preview.data || stale}
              loading={confirm.isPending}
              onClick={() => confirm.mutate()}
            >
              Create connection
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
