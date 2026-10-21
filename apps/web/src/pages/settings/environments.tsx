import { EnvironmentKey } from '@cloud-trigger/core';
import {
  ActionIcon,
  Alert,
  Button,
  Center,
  Code,
  Group,
  Loader,
  Modal,
  Pagination,
  ScrollArea,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { type HttpError, useCan, useDelete, useTable } from '@refinedev/core';
import { List, type UseModalFormReturnType, useModalForm } from '@refinedev/mantine';
import { IconAlertCircle, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import type { ChangeEvent } from 'react';

import { confirmAction } from '../../components/confirm';
import { PageHeading, pageBreadcrumb } from '../../components/page-chrome';
import { LoadError } from '../../components/PageState';
import type { EnvironmentDto } from '../../lib/api';
import { ENVIRONMENTS_KEY, environmentLabel } from '../../lib/environments';
import { focusFirstInvalidField } from '../../lib/errors';
import { unfieldedError } from './form-errors';

interface EnvironmentValues {
  key: string;
  name: string;
  description: string;
  version: number;
}

interface EnvironmentPayload {
  key: string;
  name: string;
  description: string;
  expectedVersion: number;
}

type EnvironmentForm = UseModalFormReturnType<
  EnvironmentDto,
  HttpError,
  EnvironmentValues,
  EnvironmentPayload
>;

const BLANK: EnvironmentValues = { key: '', name: '', description: '', version: 0 };

const keyProblem = (key: string): string | null => {
  const trimmed = key.trim();
  if (trimmed === '') {
    return 'Required';
  }
  const parsed = EnvironmentKey.safeParse(trimmed);

  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Not a valid key');
};

function EnvironmentFields({
  form,
  editing,
  onClose,
}: {
  form: EnvironmentForm;
  editing: boolean;
  onClose: () => void;
}) {
  const { onFinish, formLoading, mutation, query } = form.refineCore;
  const editable = editing ? ['name', 'description'] : ['key', 'name', 'description'];
  const error = unfieldedError(mutation.error, editable);
  const field = (path: 'key' | 'name' | 'description') => {
    const props = form.getInputProps(path);

    return {
      ...props,
      onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        mutation.reset();
        form.setFieldValue(path, e.currentTarget.value);
      },
    };
  };

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
      onSubmit={form.onSubmit(
        (values) => {
          void onFinish(values).then(onClose, () => focusFirstInvalidField());
        },
        () => focusFirstInvalidField(),
      )}
    >
      <Stack spacing="sm">
        <TextInput
          label="Key"
          description='Connection overlays, jobs, groups and workflows reference the environment by this key. Lowercase letters, digits, "-" and "_".'
          placeholder="staging"
          {...field('key')}
          disabled={editing}
          autoComplete="off"
          {...(!editing && { 'data-autofocus': true })}
          required
        />
        <TextInput
          label="Display name"
          autoComplete="off"
          {...(editing && { 'data-autofocus': true })}
          {...field('name')}
        />
        <Textarea label="Description" autosize minRows={2} {...field('description')} />
        {error !== null && (
          <Alert color="red" icon={<IconAlertCircle size={18} />} role="alert">
            {error}
          </Alert>
        )}
        <Group position="right">
          <Button type="submit" loading={formLoading}>
            {editing ? 'Save' : 'Create environment'}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

function useEnvironmentForm(action: 'create' | 'edit'): EnvironmentForm {
  const queryClient = useQueryClient();

  return useModalForm<EnvironmentDto, HttpError, EnvironmentValues, EnvironmentPayload>({
    initialValues: BLANK,
    validate: action === 'create' ? { key: keyProblem } : {},
    transformValues: ({ key, name, description, version }) => ({
      key: key.trim(),
      name,
      description,
      expectedVersion: version,
    }),
    refineCoreProps: {
      resource: 'environments',
      action,
      redirect: false,
      warnWhenUnsavedChanges: false,
      errorNotification: false,
      successNotification: (data) => {
        const saved = data?.data;

        return saved === undefined
          ? false
          : action === 'create'
            ? {
                type: 'success',
                message: 'Environment created',
                description: `${environmentLabel(saved)} is ready for connection overlays.`,
              }
            : {
                type: 'success',
                message: 'Environment saved',
                description: `${environmentLabel(saved)} was updated.`,
              };
      },
      onMutationSuccess: () => void queryClient.invalidateQueries({ queryKey: ENVIRONMENTS_KEY }),
    },
  });
}

export function EnvironmentList() {
  const queryClient = useQueryClient();
  const { tableQuery, currentPage, setCurrentPage, pageCount } = useTable<EnvironmentDto>({
    resource: 'environments',
    pagination: { pageSize: 50 },
  });
  const createForm = useEnvironmentForm('create');
  const editForm = useEnvironmentForm('edit');
  const { mutate: deleteEnvironment, mutation: deletion } = useDelete<EnvironmentDto>();
  const canCreate = useCan({ resource: 'environments', action: 'create' }).data?.can === true;
  const canEdit = useCan({ resource: 'environments', action: 'edit' }).data?.can === true;
  const canDelete = useCan({ resource: 'environments', action: 'delete' }).data?.can === true;
  const environments = tableQuery.data?.data ?? [];
  const closeCreate = () => {
    createForm.modal.close();
    createForm.refineCore.mutation.reset();
  };
  const closeEdit = () => {
    editForm.modal.close();
    editForm.refineCore.mutation.reset();
  };
  const remove = (environment: EnvironmentDto) =>
    deleteEnvironment(
      {
        resource: 'environments',
        id: environment.key,
        mutationMode: 'pessimistic',
        successNotification: {
          type: 'success',
          message: 'Environment deleted',
          description: `${environmentLabel(environment)} was removed.`,
        },
        errorNotification: (error) => ({
          type: 'error',
          message: `Couldn't delete ${environment.key}`,
          description: error?.message ?? 'Something went wrong',
        }),
      },
      { onSuccess: () => void queryClient.invalidateQueries({ queryKey: ENVIRONMENTS_KEY }) },
    );
  const editingKey = editForm.refineCore.id;

  return (
    <List
      title={<PageHeading>Environments</PageHeading>}
      breadcrumb={pageBreadcrumb}
      headerButtons={
        canCreate ? (
          <Button leftIcon={<IconPlus size={16} />} onClick={() => createForm.modal.show()}>
            Add environment
          </Button>
        ) : null
      }
    >
      <Text size="sm" color="dimmed" mb="md">
        A connection can override its address, credentials and endpoints per environment. Jobs,
        groups and workflows pick the environment they run in; without one they use the base
        connection config.
      </Text>
      {tableQuery.isError ? (
        <LoadError
          error={tableQuery.error}
          what="environments"
          onRetry={() => void tableQuery.refetch()}
        />
      ) : (
        <Stack spacing="md">
          <ScrollArea>
            <Table highlightOnHover verticalSpacing="xs" className="ct-table" miw={560}>
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Name</th>
                  <th>Description</th>
                  {(canEdit || canDelete) && <th aria-label="Actions" />}
                </tr>
              </thead>
              <tbody>
                {environments.map((environment) => (
                  <tr key={environment.key}>
                    <td>
                      <Code>{environment.key}</Code>
                    </td>
                    <td>
                      <Text size="sm" weight={500}>
                        {environment.name}
                      </Text>
                    </td>
                    <td>
                      <Text size="sm" color="dimmed" lineClamp={2}>
                        {environment.description}
                      </Text>
                    </td>
                    {(canEdit || canDelete) && (
                      <td>
                        <Group position="right" spacing={4} noWrap>
                          {canEdit && (
                            <Tooltip label="Edit">
                              <ActionIcon
                                size="lg"
                                onClick={() => editForm.modal.show(environment.key)}
                                aria-label={`Edit ${environment.key}`}
                              >
                                <IconPencil size={16} />
                              </ActionIcon>
                            </Tooltip>
                          )}
                          {canDelete && (
                            <Tooltip label="Delete">
                              <ActionIcon
                                size="lg"
                                color="red"
                                loading={
                                  deletion.isPending && deletion.variables?.id === environment.key
                                }
                                onClick={() =>
                                  void confirmAction({
                                    title: `Delete ${environmentLabel(environment)}?`,
                                    message:
                                      'Connection overlays for this environment stop applying. Deleting fails while a job, group, workflow or connection overlay still uses it.',
                                    confirmLabel: 'Delete environment',
                                    onConfirm: () => remove(environment),
                                  })
                                }
                                aria-label={`Delete ${environment.key}`}
                              >
                                <IconTrash size={16} />
                              </ActionIcon>
                            </Tooltip>
                          )}
                        </Group>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </Table>
            {tableQuery.isSuccess && environments.length === 0 && (
              <Text color="dimmed" p="lg" align="center">
                No environments yet.
                {canCreate &&
                  ' Add staging or production to give connections per-environment overrides.'}
              </Text>
            )}
          </ScrollArea>
          {pageCount > 1 && (
            <Pagination
              page={currentPage}
              total={pageCount}
              onChange={setCurrentPage}
              position="right"
            />
          )}
        </Stack>
      )}
      <Modal opened={createForm.modal.visible} onClose={closeCreate} title="Add environment">
        <EnvironmentFields form={createForm} editing={false} onClose={closeCreate} />
      </Modal>
      <Modal
        opened={editForm.modal.visible}
        onClose={closeEdit}
        title={editingKey === undefined ? 'Edit environment' : `Edit ${String(editingKey)}`}
      >
        <EnvironmentFields form={editForm} editing onClose={closeEdit} />
      </Modal>
    </List>
  );
}
