import type { Scope } from '@cloud-trigger/api-contract';
import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Modal,
  Pagination,
  ScrollArea,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import {
  type HttpError,
  getDefaultFilter,
  useDelete,
  useInvalidate,
  useNotification,
  useTable,
} from '@refinedev/core';
import { List, type UseModalFormReturnType, useModalForm } from '@refinedev/mantine';
import { IconKey, IconPencil, IconPlus, IconSearch, IconTrash } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { confirmAction } from '../../components/confirm';
import {
  MIN_PASSWORD,
  NewPasswordFields,
  passwordError,
  passwordValid,
} from '../../components/NewPasswordFields';
import { PageHeading, pageBreadcrumb } from '../../components/page-chrome';
import { LoadError } from '../../components/PageState';
import { ScopeBadge, ScopeLevel } from '../../components/SignInMethods';
import { useIdentity } from '../../lib/access';
import { type UserDto, client } from '../../lib/api';
import { configIssues, errorMessage, fieldError, focusFirstInvalidField } from '../../lib/errors';
import { fromNow } from '../../lib/format';
import { unfieldedError } from './form-errors';

interface CreateUserValues {
  username: string;
  password: string;
  scopes: Scope[];
}

interface EditUserValues {
  scopes: Scope[];
  disabled: boolean;
  version: number;
}

interface UserUpdate {
  scopes: Scope[];
  disabled: boolean;
  expectedVersion: number;
}

type CreateUserForm = UseModalFormReturnType<UserDto, HttpError, CreateUserValues>;
type EditUserForm = UseModalFormReturnType<UserDto, HttpError, EditUserValues, UserUpdate>;

const SearchValue = z.string().catch('');

const failureText = (error: unknown) => {
  const issues = configIssues(error);

  return issues.length > 0 ? issues.map((i) => i.message).join('; ') : errorMessage(error);
};

const isSelf = (user: UserDto, identityId: string | undefined): boolean =>
  identityId === `user:${user.username}`;

const accessChange = (user: UserDto, disabled: boolean): string => {
  if (disabled === user.disabled) {
    return `${user.username}'s access was updated`;
  }

  return disabled ? `${user.username} can no longer sign in` : `${user.username} can sign in again`;
};

function FormError({ message }: { message: string | null }) {
  if (message === null) {
    return null;
  }

  return (
    <Text size="sm" color="red" role="alert">
      {message}
    </Text>
  );
}

function CreateUserFields({ form, onClose }: { form: CreateUserForm; onClose: () => void }) {
  const [submitted, setSubmitted] = useState(false);
  const { onFinish, formLoading, mutation } = form.refineCore;

  return (
    <form
      noValidate
      onSubmit={(e) => {
        setSubmitted(true);
        form.onSubmit(
          (values) => {
            void onFinish(values).then(onClose, () => focusFirstInvalidField());
          },
          () => focusFirstInvalidField(),
        )(e);
      }}
    >
      <Stack spacing="sm">
        <TextInput
          label="Username"
          autoComplete="off"
          data-autofocus
          {...form.getInputProps('username')}
          withAsterisk
        />
        <NewPasswordFields
          label="Initial password"
          description={`At least ${MIN_PASSWORD} characters. Share it with the user securely.`}
          password={form.values.password}
          onPasswordChange={(password) => form.setFieldValue('password', password)}
          submitted={submitted}
        />
        <ScopeLevel
          label="Access"
          value={form.values.scopes}
          onChange={(scopes) => form.setFieldValue('scopes', scopes)}
          error={fieldError(form.errors, 'scopes')}
        />
        <FormError message={unfieldedError(mutation.error, ['username', 'scopes'])} />
        <Group position="right">
          <Button type="submit" loading={formLoading}>
            Create user
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

function EditUserFields({
  form,
  self,
  onClose,
}: {
  form: EditUserForm;
  self: boolean;
  onClose: () => void;
}) {
  const { onFinish, formLoading, mutation, query } = form.refineCore;
  const canSignIn = !form.values.disabled;

  if (query?.isLoading === true) {
    return (
      <Center py="lg">
        <Loader size="sm" />
      </Center>
    );
  }

  return (
    <form
      noValidate
      onSubmit={form.onSubmit((values) => {
        void onFinish(values).then(onClose, () => focusFirstInvalidField());
      })}
    >
      <Stack spacing="sm">
        <ScopeLevel
          label="Access"
          value={form.values.scopes}
          onChange={(scopes) => form.setFieldValue('scopes', scopes)}
          error={fieldError(form.errors, 'scopes')}
        />
        <Switch
          label="Can sign in"
          description={
            self
              ? "You can't turn off your own account."
              : 'Turning this off ends their sessions and blocks new sign-ins.'
          }
          checked={canSignIn}
          disabled={self && canSignIn}
          onChange={(e) => form.setFieldValue('disabled', !e.currentTarget.checked)}
        />
        <FormError message={unfieldedError(mutation.error, ['scopes'])} />
        <Group position="right">
          <Button type="submit" loading={formLoading}>
            Save
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

function ResetPasswordForm({ user, onDone }: { user: UserDto; onDone: () => void }) {
  const { open } = useNotification();
  const invalidate = useInvalidate();
  const [password, setPassword] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const reset = useMutation({
    mutationFn: (next: string) => client.users.resetPassword({ id: user.id, password: next }),
    onSuccess: () => {
      open?.({
        type: 'success',
        message: 'Password set',
        description: `${user.username} was signed out and must use the new password.`,
      });
      void invalidate({ resource: 'users', invalidates: ['list'] });
      onDone();
    },
  });

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
        reset.mutate(password);
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
        <FormError message={reset.error ? failureText(reset.error) : null} />
        <Group position="right">
          <Button type="submit" loading={reset.isPending}>
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

function useCreateUserForm(): CreateUserForm {
  return useModalForm<UserDto, HttpError, CreateUserValues>({
    initialValues: { username: '', password: '', scopes: ['read'] },
    validate: {
      username: (value) => (value.trim() === '' ? 'Enter a username' : null),
      password: (value) => passwordError(value, true) ?? null,
    },
    transformValues: (values) => ({ ...values, username: values.username.trim() }),
    refineCoreProps: {
      resource: 'users',
      action: 'create',
      redirect: false,
      warnWhenUnsavedChanges: false,
      errorNotification: false,
      successNotification: (data) => ({
        type: 'success',
        message: 'User created',
        description: `${data?.data.username ?? 'The user'} can now sign in.`,
      }),
    },
  });
}

function useEditUserForm(before: UserDto | null): EditUserForm {
  return useModalForm<UserDto, HttpError, EditUserValues, UserUpdate>({
    initialValues: { scopes: [], disabled: false, version: 0 },
    transformValues: ({ scopes, disabled, version }) => ({
      scopes,
      disabled,
      expectedVersion: version,
    }),
    refineCoreProps: {
      resource: 'users',
      action: 'edit',
      redirect: false,
      warnWhenUnsavedChanges: false,
      errorNotification: false,
      successNotification: (data) => {
        const saved = data?.data;

        return saved === undefined
          ? false
          : {
              type: 'success',
              message: `${saved.username} updated`,
              description: accessChange(before ?? saved, saved.disabled),
            };
      },
    },
  });
}

export function UserList() {
  const { identity } = useIdentity();
  const { tableQuery, currentPage, setCurrentPage, pageCount, filters, setFilters } =
    useTable<UserDto>({
      resource: 'users',
      pagination: { pageSize: 50 },
    });
  const appliedSearch = SearchValue.parse(getDefaultFilter('search', filters, 'contains'));
  const [draft, setDraft] = useState({ base: appliedSearch, value: appliedSearch });
  const search = draft.base === appliedSearch ? draft.value : appliedSearch;
  const [debounced] = useDebouncedValue(search.trim(), 250);
  useEffect(() => {
    setFilters(
      [{ field: 'search', operator: 'contains', value: debounced || undefined }],
      'replace',
    );
  }, [debounced, setFilters]);
  const createForm = useCreateUserForm();
  const [editing, setEditing] = useState<UserDto | null>(null);
  const editForm = useEditUserForm(editing);
  const [passwordFor, setPasswordFor] = useState<UserDto | null>(null);
  const { mutate: deleteUser, mutation: deletion } = useDelete<UserDto>();
  const changeSearch = (value: string) => {
    setDraft({ base: appliedSearch, value });
    setCurrentPage(1);
  };
  const clearSearch = () => {
    setDraft({ base: '', value: '' });
    setFilters([{ field: 'search', operator: 'contains', value: undefined }], 'replace');
    setCurrentPage(1);
  };
  const closeCreate = () => {
    createForm.modal.close();
    createForm.refineCore.mutation.reset();
  };
  const openEdit = (user: UserDto) => {
    setEditing(user);
    editForm.modal.show(user.id);
  };
  const closeEdit = () => {
    editForm.modal.close();
    editForm.refineCore.mutation.reset();
  };
  const remove = (user: UserDto) =>
    deleteUser({
      resource: 'users',
      id: user.id,
      mutationMode: 'pessimistic',
      successNotification: {
        type: 'success',
        message: 'User deleted',
        description: `${user.username} can no longer sign in.`,
      },
      errorNotification: (error) => ({
        type: 'error',
        message: `Couldn't delete ${user.username}`,
        description: error?.message ?? 'Something went wrong',
      }),
    });
  const items = tableQuery.data?.data ?? [];

  return (
    <List
      title={<PageHeading>Users</PageHeading>}
      breadcrumb={pageBreadcrumb}
      headerButtons={
        <Button leftIcon={<IconPlus size={16} />} onClick={() => createForm.modal.show()}>
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
          rightSection={tableQuery.isFetching ? <Loader size="xs" /> : null}
          value={search}
          onChange={(e) => changeSearch(e.currentTarget.value)}
        />
        {tableQuery.isError ? (
          <LoadError
            error={tableQuery.error}
            what="users"
            onRetry={() => void tableQuery.refetch()}
          />
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
                          deleting={deletion.isPending && deletion.variables?.id === user.id}
                          onEdit={() => openEdit(user)}
                          onPassword={() => setPasswordFor(user)}
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
            {tableQuery.isSuccess && items.length === 0 && (
              <Stack align="center" spacing="xs" p="lg">
                <Text color="dimmed" align="center">
                  {appliedSearch === '' ? 'No users yet.' : `No users match “${appliedSearch}”.`}
                </Text>
                {appliedSearch !== '' && (
                  <Button size="xs" variant="default" onClick={clearSearch}>
                    Clear search
                  </Button>
                )}
              </Stack>
            )}
          </ScrollArea>
        )}
        {pageCount > 1 && (
          <Pagination
            page={currentPage}
            total={pageCount}
            onChange={setCurrentPage}
            position="right"
          />
        )}
      </Stack>
      <Modal opened={createForm.modal.visible} onClose={closeCreate} title="Add user">
        <CreateUserFields form={createForm} onClose={closeCreate} />
      </Modal>
      <Modal
        opened={editForm.modal.visible}
        onClose={closeEdit}
        title={editing ? `Edit ${editing.username}` : 'Edit user'}
      >
        <EditUserFields
          form={editForm}
          self={editing !== null && isSelf(editing, identity?.id)}
          onClose={closeEdit}
        />
      </Modal>
      <Modal
        opened={passwordFor !== null}
        onClose={() => setPasswordFor(null)}
        title={passwordFor ? `Set password for ${passwordFor.username}` : ''}
      >
        {passwordFor && (
          <ResetPasswordForm user={passwordFor} onDone={() => setPasswordFor(null)} />
        )}
      </Modal>
    </List>
  );
}
