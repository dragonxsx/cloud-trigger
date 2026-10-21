import type { Scope } from '@cloud-trigger/api-contract';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Code,
  Group,
  Modal,
  ScrollArea,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { List } from '@refinedev/mantine';
import { IconCopy, IconKeyOff, IconPlus } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { confirmAction } from '../../components/confirm';
import { PageHeading, pageBreadcrumb } from '../../components/page-chrome';
import { LoadError } from '../../components/PageState';
import { copyToClipboard } from '../../components/ShareButtons';
import { ScopeBadge, ScopeLevel } from '../../components/SignInMethods';
import { type ApiKeyDto, type CreatedApiKeyDto, client } from '../../lib/api';
import { errorMessage, notifyError } from '../../lib/errors';
import { fromNow } from '../../lib/format';

const KEYS_KEY = ['api-keys'];

function CreateKeyForm({
  saving,
  onSavingChange,
  onCreated,
}: {
  saving: boolean;
  onSavingChange: (saving: boolean) => void;
  onCreated: (key: CreatedApiKeyDto) => void;
}) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Scope[]>(['write']);
  const [error, setError] = useState<string | null>(null);
  const nameError = error ?? undefined;

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() === '') {
          setError('Enter a name, such as ci or terraform');

          return;
        }
        onSavingChange(true);
        setError(null);
        client.apiKeys
          .create({ name: name.trim(), scopes })
          .then(onCreated)
          .catch((failure: unknown) => setError(errorMessage(failure)))
          .finally(() => onSavingChange(false));
      }}
    >
      <Stack spacing="sm">
        <TextInput
          label="Name"
          description="Who or what uses this key, such as ci or terraform."
          autoComplete="off"
          data-autofocus
          value={name}
          onChange={(e) => {
            setError(null);
            setName(e.currentTarget.value);
          }}
          {...(nameError === undefined ? {} : { error: nameError })}
          withAsterisk
        />
        <ScopeLevel label="Access" value={scopes} onChange={setScopes} />
        <Group position="right">
          <Button type="submit" loading={saving}>
            Create key
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

function NewKey({ created, onClose }: { created: CreatedApiKeyDto; onClose: () => void }) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [saved, setSaved] = useState(false);
  const ready = saved || copy === 'copied';

  return (
    <Stack spacing="sm">
      <Alert color="yellow">
        Copy the key now and store it somewhere safe. It is not shown again.
      </Alert>
      <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', userSelect: 'all' }}>
        {created.key}
      </Code>
      <Group spacing="sm">
        <Button
          variant="light"
          leftIcon={<IconCopy size={16} />}
          onClick={() => {
            void copyToClipboard(created.key).then((ok) => setCopy(ok ? 'copied' : 'failed'));
          }}
        >
          {copy === 'copied' ? 'Copied' : 'Copy key'}
        </Button>
        <output className="ct-sr-only">{copy === 'copied' ? 'Key copied' : ''}</output>
        {copy === 'failed' && (
          <Text size="sm" color="red" role="alert">
            Couldn&apos;t copy. Select the key above and copy it by hand.
          </Text>
        )}
      </Group>
      <Checkbox
        label="I've saved this key somewhere safe"
        checked={ready}
        disabled={copy === 'copied'}
        onChange={(e) => setSaved(e.currentTarget.checked)}
      />
      <Group position="right">
        <Button onClick={onClose} disabled={!ready}>
          Done
        </Button>
      </Group>
    </Stack>
  );
}

function KeyRow({
  apiKey,
  revoking,
  onRevoke,
}: {
  apiKey: ApiKeyDto;
  revoking: boolean;
  onRevoke: () => void;
}) {
  return (
    <tr>
      <td>
        <Text size="sm" weight={500}>
          {apiKey.name}
        </Text>
      </td>
      <td>
        <Code>{apiKey.prefix}…</Code>
      </td>
      <td>
        <ScopeBadge scopes={apiKey.scopes} />
      </td>
      <td>
        {apiKey.revokedAt ? (
          <Badge size="sm" color="red" variant="dot">
            Revoked {fromNow(apiKey.revokedAt)}
          </Badge>
        ) : (
          <Badge size="sm" color="teal" variant="dot">
            Active
          </Badge>
        )}
      </td>
      <td>
        <Text size="sm" color="dimmed">
          {apiKey.lastUsedAt ? fromNow(apiKey.lastUsedAt) : 'Never'}
        </Text>
      </td>
      <td>
        {!apiKey.revokedAt && (
          <Group position="right">
            <Tooltip label="Revoke key">
              <ActionIcon
                size="lg"
                color="red"
                loading={revoking}
                onClick={onRevoke}
                aria-label={`Revoke ${apiKey.name}`}
              >
                <IconKeyOff size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>
        )}
      </td>
    </tr>
  );
}

export function ApiKeyList() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<CreatedApiKeyDto | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const keys = useQuery({ queryKey: KEYS_KEY, queryFn: () => client.apiKeys.list({}) });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: KEYS_KEY });
  const revoke = async (key: ApiKeyDto) => {
    setRevoking(key.id);
    try {
      await client.apiKeys.revoke({ id: key.id });
      showNotification({
        color: 'teal',
        title: 'Key revoked',
        message: `${key.name} no longer works.`,
      });
      refresh();
    } catch (error: unknown) {
      notifyError(`Couldn't revoke ${key.name}`, error);
    } finally {
      setRevoking(null);
    }
  };
  const close = () => {
    setCreating(false);
    setCreated(null);
  };
  const all = keys.data ?? [];
  const revokedCount = all.filter((key) => key.revokedAt).length;
  const visible = showRevoked ? all : all.filter((key) => !key.revokedAt);
  const locked = created !== null || saving;

  return (
    <List
      title={<PageHeading>API keys</PageHeading>}
      breadcrumb={pageBreadcrumb}
      headerButtons={
        <Button leftIcon={<IconPlus size={16} />} onClick={() => setCreating(true)}>
          Create key
        </Button>
      }
    >
      {keys.error ? (
        <LoadError error={keys.error} what="API keys" onRetry={() => void keys.refetch()} />
      ) : (
        <Stack spacing="sm">
          {revokedCount > 0 && (
            <Switch
              label={`Show revoked keys (${String(revokedCount)})`}
              checked={showRevoked}
              onChange={(e) => setShowRevoked(e.currentTarget.checked)}
            />
          )}
          <ScrollArea>
            <Table highlightOnHover verticalSpacing="xs" className="ct-table" miw={720}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Key</th>
                  <th>Access</th>
                  <th>Status</th>
                  <th>Last used</th>
                  <th>
                    <span className="ct-sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((key) => (
                  <KeyRow
                    key={key.id}
                    apiKey={key}
                    revoking={revoking === key.id}
                    onRevoke={() =>
                      void confirmAction({
                        title: `Revoke ${key.name}?`,
                        message:
                          'Anything using this key gets 401 errors right away. This cannot be undone.',
                        confirmLabel: 'Revoke key',
                        onConfirm: () => revoke(key),
                      })
                    }
                  />
                ))}
              </tbody>
            </Table>
            {keys.isSuccess && visible.length === 0 && (
              <Text color="dimmed" p="lg" align="center">
                {all.length === 0
                  ? 'No API keys yet. Keys let scripts and CI call the API with the x-api-key header.'
                  : 'No active keys. Turn on "Show revoked keys" to see the others.'}
              </Text>
            )}
          </ScrollArea>
        </Stack>
      )}
      <Modal
        opened={creating}
        onClose={close}
        title={created ? 'Your new key' : 'Create API key'}
        closeOnEscape={!locked}
        closeOnClickOutside={!locked}
        withCloseButton={!locked}
      >
        {created ? (
          <NewKey created={created} onClose={close} />
        ) : (
          <CreateKeyForm
            saving={saving}
            onSavingChange={setSaving}
            onCreated={(key) => {
              setCreated(key);
              refresh();
            }}
          />
        )}
      </Modal>
    </List>
  );
}
