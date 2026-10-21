import type { Scope } from '@cloud-trigger/api-contract';
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Loader,
  Modal,
  ScrollArea,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { showNotification } from '@mantine/notifications';
import { List } from '@refinedev/mantine';
import { IconKey, IconPencil, IconPlus, IconSearch, IconTrash } from '@tabler/icons-react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { confirmAction } from '../../components/confirm';
import { NewPasswordFields, passwordValid, MIN_PASSWORD } from '../../components/NewPasswordFields';
import { PageHeading, pageBreadcrumb } from '../../components/page-chrome';
import { LoadError } from '../../components/PageState';
import { ScopeBadge, ScopeLevel } from '../../components/SignInMethods';
import { useIdentity } from '../../lib/access';
import { type UserDto, client } from '../../lib/api';
import { configIssues, errorMessage, focusFirstInvalidField } from '../../lib/errors';
import { fromNow } from '../../lib/format';

const USERS_KEY = ['users'];

type Dialog =
  | { kind: 'create' }
  | { kind: 'edit'; user: UserDto }
  | { kind: 'password'; user: UserDto }
  | null;

const failureText = (error: unknown) => {
  const issues = configIssues(error);

  return issues.length > 0 ? issues.map((i) => i.message).join('; ') : errorMessage(error);
};

const isSelf = (user: UserDto, identityId: string | undefined): boolean =>
  identityId === `user:${user.username}`;

function CreateUserForm({ onDone }: { onDone: (username: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [scopes, setScopes] = useState<Scope[]>(['read']);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const usernameError = submitted && username.trim() === '' ? 'Enter a username' : undefined;

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setSubmitted(true);
        if (username.trim() === '' || !passwordValid(password)) {
          focusFirstInvalidField(e.currentTarget);

          return;
        }
        setSaving(true);
        setError(null);
        const name = username.trim();
        client.users
          .create({ username: name, password, scopes })
          .then(() => onDone(name))
          .catch((failure: unknown) => setError(failureText(failure)))
          .finally(() => setSaving(false));
      }}
    >
      <Stack spacing="sm">
        <TextInput
          label="Username"
          autoComplete="off"
          data-autofocus
          value={username}
          onChange={(e) => setUsername(e.currentTarget.value)}
          {...(usernameError === undefined ? {} : { error: usernameError })}
          withAsterisk
        />
        <NewPasswordFields
          label="Initial password"
          description={`At least ${MIN_PASSWORD} characters. Share it with the user securely.`}
          password={password}
          onPasswordChange={setPassword}
          submitted={submitted}
        />
        <ScopeLevel label="Access" value={scopes} onChange={setScopes} />
        {error && (
          <Text size="sm" color="red" role="alert">
            {error}
          </Text>
        )}
        <Group position="right">
          <Button type="submit" loading={saving}>
            Create user
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

function EditUserForm({
  user,
  self,
  onDone,
}: {
  user: UserDto;
  self: boolean;
  onDone: (user: UserDto, change: string) => void;
}) {
  const [scopes, setScopes] = useState<Scope[]>(user.scopes);
  const [canSignIn, setCanSignIn] = useState(!user.disabled);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const change =
    canSignIn === user.disabled
      ? canSignIn
        ? `${user.username} can sign in again`
        : `${user.username} can no longer sign in`
      : `${user.username}'s access was updated`;

  return (
    <Stack spacing="sm">
      <ScopeLevel label="Access" value={scopes} onChange={setScopes} />
      <Switch
        label="Can sign in"
        description={
          self
            ? "You can't turn off your own account."
            : 'Turning this off ends their sessions and blocks new sign-ins.'
        }
        checked={canSignIn}
        disabled={self && canSignIn}
        onChange={(e) => setCanSignIn(e.currentTarget.checked)}
      />
      {error && (
        <Text size="sm" color="red" role="alert">
          {error}
        </Text>
      )}
      <Group position="right">
        <Button
          loading={saving}
          onClick={() => {
            setSaving(true);
            setError(null);
            client.users
              .update({
                id: user.id,
                expectedVersion: user.version,
                scopes,
                disabled: !canSignIn,
              })
              .then(() => onDone(user, change))
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

function ResetPasswordForm({ user, onDone }: { user: UserDto; onDone: (user: UserDto) => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setSubmitted(true);
        if (!passwordValid(password)) {
          focusFirstInvalidField(e.currentTarget);

          return;
        }
        setSaving(true);
        setError(null);
        client.users
          .resetPassword({ id: user.id, password })
          .then(() => onDone(user))
          .catch((failure: unknown) => setError(failureText(failure)))
          .finally(() => setSaving(false));
      }}
    >
      <Stack spacing="sm">
        <Text size="sm" color="dimmed">
          Setting a new password signs {user.username} out everywhere.
        </Text>
        <NewPasswordFields
          password={password}
          onPasswordChange={setPassword}
          submitted={submitted}
        />
        {error && (
          <Text size="sm" color="red" role="alert">
            {error}
          </Text>
        )}
        <Group position="right">
          <Button type="submit" loading={saving}>
            Set password
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

function UserActions({
  user,
  self,
  deleting,
  onEdit,
  onPassword,
  onDelete,
}: {
  user: UserDto;
  self: boolean;
  deleting: boolean;
  onEdit: () => void;
  onPassword: () => void;
  onDelete: () => void;
}) {
  return (
    <Group spacing={4} position="right" noWrap>
      <Tooltip label="Edit access">
        <ActionIcon size="lg" onClick={onEdit} aria-label={`Edit ${user.username}`}>
          <IconPencil size={16} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Set password">
        <ActionIcon size="lg" onClick={onPassword} aria-label={`Set password for ${user.username}`}>
          <IconKey size={16} />
        </ActionIcon>
      </Tooltip>
      {!self && (
        <Tooltip label="Delete user">
          <ActionIcon
            size="lg"
            color="red"
            loading={deleting}
            onClick={onDelete}
            aria-label={`Delete ${user.username}`}
          >
            <IconTrash size={16} />
          </ActionIcon>
        </Tooltip>
      )}
    </Group>
  );
}

export function UserList() {
  const queryClient = useQueryClient();
  const { identity } = useIdentity();
  const [search, setSearch] = useState('');
  const [debounced] = useDebouncedValue(search.trim(), 250);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const users = useQuery({
    queryKey: [...USERS_KEY, debounced],
    queryFn: () =>
      client.users.list({ limit: 200, ...(debounced !== '' && { search: debounced }) }),
    placeholderData: keepPreviousData,
  });
  const done = (title: string, message: string) => {
    setDialog(null);
    showNotification({ color: 'teal', title, message });
    void queryClient.invalidateQueries({ queryKey: USERS_KEY });
  };
  const remove = async (user: UserDto) => {
    setDeleting(user.id);
    try {
      await client.users.delete({ id: user.id });
      done('User deleted', `${user.username} can no longer sign in.`);
    } catch (error: unknown) {
      showNotification({
        color: 'red',
        title: `Couldn't delete ${user.username}`,
        message: failureText(error),
      });
    } finally {
      setDeleting(null);
    }
  };
  const items = users.data?.items ?? [];

  return (
    <List
      title={<PageHeading>Users</PageHeading>}
      breadcrumb={pageBreadcrumb}
      headerButtons={
        <Button leftIcon={<IconPlus size={16} />} onClick={() => setDialog({ kind: 'create' })}>
          Add user
        </Button>
      }
    >
      <Stack spacing="md">
        <TextInput
          placeholder="Search usernames"
          aria-label="Search usernames"
          type="search"
          maw={320}
          icon={<IconSearch size={16} />}
          rightSection={users.isFetching ? <Loader size="xs" /> : null}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
        />
        {users.error ? (
          <LoadError error={users.error} what="users" onRetry={() => void users.refetch()} />
        ) : (
          <ScrollArea>
            <Table highlightOnHover verticalSpacing="xs" className="ct-table" miw={640}>
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Access</th>
                  <th>Status</th>
                  <th>Last sign-in</th>
                  <th>
                    <span className="ct-sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((user) => {
                  const self = isSelf(user, identity?.id);

                  return (
                    <tr key={user.id}>
                      <td>
                        <Group spacing={6} noWrap>
                          <Text size="sm" weight={500}>
                            {user.username}
                          </Text>
                          {self && (
                            <Badge size="xs" variant="outline" color="gray">
                              You
                            </Badge>
                          )}
                        </Group>
                      </td>
                      <td>
                        <ScopeBadge scopes={user.scopes} />
                      </td>
                      <td>
                        <Badge size="sm" color={user.disabled ? 'gray' : 'teal'} variant="dot">
                          {user.disabled ? "Can't sign in" : 'Active'}
                        </Badge>
                      </td>
                      <td>
                        <Text size="sm" color="dimmed">
                          {user.lastLoginAt ? fromNow(user.lastLoginAt) : 'Never'}
                        </Text>
                      </td>
                      <td>
                        <UserActions
                          user={user}
                          self={self}
                          deleting={deleting === user.id}
                          onEdit={() => setDialog({ kind: 'edit', user })}
                          onPassword={() => setDialog({ kind: 'password', user })}
                          onDelete={() =>
                            void confirmAction({
                              title: `Delete ${user.username}?`,
                              message:
                                'They are signed out and lose access right away. This cannot be undone.',
                              confirmLabel: 'Delete user',
                              onConfirm: () => remove(user),
                            })
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            {users.isSuccess && items.length === 0 && (
              <Stack align="center" spacing="xs" p="lg">
                <Text color="dimmed" align="center">
                  {debounced === '' ? 'No users yet.' : `No users match “${debounced}”.`}
                </Text>
                {debounced !== '' && (
                  <Button size="xs" variant="default" onClick={() => setSearch('')}>
                    Clear search
                  </Button>
                )}
              </Stack>
            )}
          </ScrollArea>
        )}
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
        {dialog?.kind === 'create' && (
          <CreateUserForm
            onDone={(username) => done('User created', `${username} can now sign in.`)}
          />
        )}
        {dialog?.kind === 'edit' && (
          <EditUserForm
            user={dialog.user}
            self={isSelf(dialog.user, identity?.id)}
            onDone={(user, change) => done(`${user.username} updated`, change)}
          />
        )}
        {dialog?.kind === 'password' && (
          <ResetPasswordForm
            user={dialog.user}
            onDone={(user) =>
              done('Password set', `${user.username} was signed out and must use the new password.`)
            }
          />
        )}
      </Modal>
    </List>
  );
}
