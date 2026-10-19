import type { Scope } from '@cloud-trigger/api-contract';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Code,
  CopyButton,
  Group,
  Modal,
  ScrollArea,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { List } from '@refinedev/mantine';
import { IconCopy, IconPlus, IconTrash } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ScopeChips } from '../../components/SignInMethods';
import { type ApiKeyDto, type CreatedApiKeyDto, client } from '../../lib/api';
import { errorMessage, notifyError } from '../../lib/errors';
import { fromNow } from '../../lib/format';

const KEYS_KEY = ['api-keys'];

function CreateKeyForm({ onCreated }: { onCreated: (key: CreatedApiKeyDto) => void }) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Scope[]>(['write']);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setSaving(true);
        client.apiKeys
          .create({ name: name.trim(), scopes })
          .then(onCreated)
          .catch((failure: unknown) => setError(errorMessage(failure)))
          .finally(() => setSaving(false));
      }}
    >
      <Stack spacing="sm">
        <TextInput
          label="Name"
          description="Who or what uses this key, such as ci or terraform."
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          {...(error ? { error } : {})}
          required
        />
        <Text size="sm" weight={500}>
          Scopes
        </Text>
        <ScopeChips value={scopes} onChange={setScopes} />
        <Group position="right">
          <Button
            type="submit"
            loading={saving}
            disabled={name.trim() === '' || scopes.length === 0}
          >
            Create key
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

function NewKey({ created, onClose }: { created: CreatedApiKeyDto; onClose: () => void }) {
  return (
    <Stack spacing="sm">
      <Alert color="yellow">Copy the key now. It is not shown again.</Alert>
      <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
        {created.key}
      </Code>
      <Group position="apart">
        <CopyButton value={created.key}>
          {(clipboard) => (
            <Button
              variant="light"
              leftIcon={<IconCopy size={16} />}
              onClick={() => clipboard.copy()}
            >
              {clipboard.copied ? 'Copied' : 'Copy key'}
            </Button>
          )}
        </CopyButton>
        <Button onClick={onClose}>Done</Button>
      </Group>
    </Stack>
  );
}

export function ApiKeyList() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedApiKeyDto | null>(null);
  const keys = useQuery({ queryKey: KEYS_KEY, queryFn: () => client.apiKeys.list({}) });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: KEYS_KEY });
  const revoke = async (key: ApiKeyDto) => {
    try {
      await client.apiKeys.revoke({ id: key.id });
      showNotification({ color: 'teal', title: 'Revoked', message: `${key.name} no longer works` });
      refresh();
    } catch (error: unknown) {
      notifyError('Not revoked', error);
    }
  };
  const close = () => {
    setCreating(false);
    setCreated(null);
  };

  return (
    <List
      title="API keys"
      headerButtons={
        <Button leftIcon={<IconPlus size={16} />} onClick={() => setCreating(true)}>
          Create key
        </Button>
      }
    >
      <ScrollArea>
        <Table highlightOnHover verticalSpacing="xs" className="ct-table" miw={640}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Key</th>
              <th>Scopes</th>
              <th>Last used</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {(keys.data ?? []).map((key) => (
              <tr key={key.id} style={key.revokedAt ? { opacity: 0.55 } : undefined}>
                <td>
                  <Text size="sm" weight={500}>
                    {key.name}
                  </Text>
                </td>
                <td>
                  <Code>{key.prefix}…</Code>
                </td>
                <td>
                  <Group spacing={4}>
                    {key.scopes.map((scope) => (
                      <Badge key={scope} size="sm" variant="light">
                        {scope}
                      </Badge>
                    ))}
                  </Group>
                </td>
                <td>
                  <Text size="sm" color="dimmed">
                    {key.revokedAt
                      ? `Revoked ${fromNow(key.revokedAt)}`
                      : key.lastUsedAt
                        ? fromNow(key.lastUsedAt)
                        : 'Never'}
                  </Text>
                </td>
                <td>
                  {!key.revokedAt && (
                    <Group position="right">
                      <Tooltip label="Revoke">
                        <ActionIcon
                          color="red"
                          onClick={() => void revoke(key)}
                          aria-label="Revoke"
                        >
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
        {keys.data?.length === 0 && (
          <Text color="dimmed" p="lg" align="center">
            No API keys yet. Keys let scripts and CI call the API with the x-api-key header.
          </Text>
        )}
      </ScrollArea>
      <Modal opened={creating} onClose={close} title={created ? 'Your new key' : 'Create API key'}>
        {created ? (
          <NewKey created={created} onClose={close} />
        ) : (
          <CreateKeyForm
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
