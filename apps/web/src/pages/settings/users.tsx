import type { Scope } from '@cloud-trigger/api-contract';
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Modal,
  PasswordInput,
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
import { IconKey, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ScopeChips } from '../../components/SignInMethods';
import { type UserDto, client } from '../../lib/api';
import { configIssues, errorMessage } from '../../lib/errors';
import { fromNow } from '../../lib/format';

const USERS_KEY = ['users'];
const MIN_PASSWORD = 12;

type Dialog =
  | { kind: 'create' }
  | { kind: 'edit'; user: UserDto }
  | { kind: 'password'; user: UserDto }
  | null;

const failureText = (error: unknown) => {
  const issues = configIssues(error);

  return issues.length > 0 ? issues.map((i) => i.message).join('; ') : errorMessage(error);
};

function CreateUserForm({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [scopes, setScopes] = useState<Scope[]>(['read']);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setSaving(true);
        client.users
          .create({ username: username.trim(), password, scopes })
          .then(onDone)
          .catch((failure: unknown) => setError(failureText(failure)))
          .finally(() => setSaving(false));
      }}
    >
      <Stack spacing="sm">
        <TextInput
          label="Username"
          value={username}
          onChange={(e) => setUsername(e.currentTarget.value)}
          required
        />
        <PasswordInput
          label="Initial password"
          description={`At least ${MIN_PASSWORD} characters. Share it with the user securely.`}
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
          required
        />
        <Text size="sm" weight={500}>
          Scopes
        </Text>
        <ScopeChips value={scopes} onChange={setScopes} />
        {error && (
          <Text size="sm" color="red">
            {error}
          </Text>
        )}
        <Group position="right">
          <Button
            type="submit"
            loading={saving}
            disabled={
              username.trim() === '' || password.length < MIN_PASSWORD || scopes.length === 0
            }
          >
            Create user
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

function EditUserForm({ user, onDone }: { user: UserDto; onDone: () => void }) {
  const [scopes, setScopes] = useState<Scope[]>(user.scopes);
  const [disabled, setDisabled] = useState(user.disabled);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  return (
    <Stack spacing="sm">
      <Text size="sm" weight={500}>
        Scopes
      </Text>
      <ScopeChips value={scopes} onChange={setScopes} />
      <Switch
        label="Disabled"
        description="A disabled user cannot sign in, and their sessions end."
        checked={disabled}
        onChange={(e) => setDisabled(e.currentTarget.checked)}
      />
      {error && (
        <Text size="sm" color="red">
          {error}
        </Text>
      )}
      <Group position="right">
        <Button
          loading={saving}
          disabled={scopes.length === 0}
          onClick={() => {
            setSaving(true);
            client.users
              .update({ id: user.id, expectedVersion: user.version, scopes, disabled })
              .then(onDone)
              .catch((failure: unknown) => setError(failureText(failure)))
              .finally(() => setSaving(false));
          }}
        >
          Save
        </Button>
      </Group>
    </Stack>
  );
}

function ResetPasswordForm({ user, onDone }: { user: UserDto; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setSaving(true);
        client.users
          .resetPassword({ id: user.id, password })
          .then(onDone)
          .catch((failure: unknown) => setError(failureText(failure)))
          .finally(() => setSaving(false));
      }}
    >
      <Stack spacing="sm">
        <Text size="sm" color="dimmed">
          Setting a new password signs {user.username} out everywhere.
        </Text>
        <PasswordInput
          label="New password"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
          {...(error ? { error } : {})}
          required
        />
        <Group position="right">
          <Button type="submit" loading={saving} disabled={password.length < MIN_PASSWORD}>
            Set password
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

export function UserList() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const users = useQuery({
    queryKey: [...USERS_KEY, search],
    queryFn: () =>
      client.users.list({ limit: 200, ...(search.trim() && { search: search.trim() }) }),
  });
  const done = (message: string) => () => {
    setDialog(null);
    showNotification({ color: 'teal', title: 'Saved', message });
    void queryClient.invalidateQueries({ queryKey: USERS_KEY });
  };
  const remove = (user: UserDto) => {
    client.users
      .delete({ id: user.id })
      .then(done(`${user.username} was deleted`))
      .catch((error: unknown) =>
        showNotification({ color: 'red', title: 'Not deleted', message: failureText(error) }),
      );
  };

  return (
    <List
      title="Users"
      headerButtons={
        <Button leftIcon={<IconPlus size={16} />} onClick={() => setDialog({ kind: 'create' })}>
          Add user
        </Button>
      }
    >
      <Stack spacing="md">
        <TextInput
          placeholder="Search usernames"
          maw={320}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
        />
        <ScrollArea>
          <Table highlightOnHover verticalSpacing="xs" className="ct-table" miw={640}>
            <thead>
              <tr>
                <th>Username</th>
                <th>Scopes</th>
                <th>Status</th>
                <th>Last sign-in</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {(users.data?.items ?? []).map((user) => (
                <tr key={user.id}>
                  <td>
                    <Text size="sm" weight={500}>
                      {user.username}
                    </Text>
                  </td>
                  <td>
                    <Group spacing={4}>
                      {user.scopes.map((scope) => (
                        <Badge key={scope} size="sm" variant="light">
                          {scope}
                        </Badge>
                      ))}
                    </Group>
                  </td>
                  <td>
                    <Badge size="sm" color={user.disabled ? 'gray' : 'teal'} variant="dot">
                      {user.disabled ? 'Disabled' : 'Active'}
                    </Badge>
                  </td>
                  <td>
                    <Text size="sm" color="dimmed">
                      {user.lastLoginAt ? fromNow(user.lastLoginAt) : 'Never'}
                    </Text>
                  </td>
                  <td>
                    <Group spacing={4} position="right" noWrap>
                      <Tooltip label="Edit">
                        <ActionIcon
                          onClick={() => setDialog({ kind: 'edit', user })}
                          aria-label="Edit"
                        >
                          <IconPencil size={16} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Set password">
                        <ActionIcon
                          onClick={() => setDialog({ kind: 'password', user })}
                          aria-label="Set password"
                        >
                          <IconKey size={16} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Delete">
                        <ActionIcon color="red" onClick={() => remove(user)} aria-label="Delete">
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </ScrollArea>
      </Stack>
      <Modal
        opened={dialog !== null}
        onClose={() => setDialog(null)}
        title={
          dialog?.kind === 'create'
            ? 'Add user'
            : dialog?.kind === 'edit'
              ? `Edit ${dialog.user.username}`
              : dialog?.kind === 'password'
                ? `Set password for ${dialog.user.username}`
                : ''
        }
      >
        {dialog?.kind === 'create' && <CreateUserForm onDone={done('User created')} />}
        {dialog?.kind === 'edit' && (
          <EditUserForm user={dialog.user} onDone={done(`${dialog.user.username} was updated`)} />
        )}
        {dialog?.kind === 'password' && (
          <ResetPasswordForm user={dialog.user} onDone={done('Password changed')} />
        )}
      </Modal>
    </List>
  );
}
