import { EnvironmentKey } from '@cloud-trigger/core';
import {
  ActionIcon,
  Alert,
  Button,
  Code,
  Group,
  Modal,
  ScrollArea,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { useCan } from '@refinedev/core';
import { List } from '@refinedev/mantine';
import { IconAlertCircle, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';

import { confirmAction } from '../../components/confirm';
import { PageHeading, pageBreadcrumb } from '../../components/page-chrome';
import { LoadError } from '../../components/PageState';
import { type EnvironmentDto, client } from '../../lib/api';
import { ENVIRONMENTS_KEY, environmentLabel, useEnvironments } from '../../lib/environments';
import { focusFirstInvalidField, notifyError, toHttpError } from '../../lib/errors';

const keyProblem = (key: string): string | null => {
  const trimmed = key.trim();
  if (trimmed === '') {
    return 'Required';
  }
  const parsed = EnvironmentKey.safeParse(trimmed);

  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Not a valid key');
};

function EnvironmentForm({
  editing,
  onSaved,
}: {
  editing: EnvironmentDto | null;
  onSaved: (saved: EnvironmentDto) => void;
}) {
  const [key, setKey] = useState(editing?.key ?? '');
  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [keyError, setKeyError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const save = () => {
    const spec = { key: key.trim(), name, description };

    return editing
      ? client.environments.update({ ...spec, expectedVersion: editing.version })
      : client.environments.create(spec);
  };
  const fail = (failure: unknown) => {
    const http = toHttpError(failure);
    const onKey = editing === null ? http.errors?.['key'] : undefined;
    const keyMessage = Array.isArray(onKey) && typeof onKey[0] === 'string' ? onKey[0] : null;
    setKeyError(keyMessage);
    setError(keyMessage === null ? http.message : null);
    if (formRef.current) {
      focusFirstInvalidField(formRef.current);
    }
  };

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const problem = editing === null ? keyProblem(key) : null;
        if (problem !== null) {
          setKeyError(problem);
          setError(null);
          if (formRef.current) {
            focusFirstInvalidField(formRef.current);
          }

          return;
        }
        setSaving(true);
        setError(null);
        save()
          .then(onSaved)
          .catch(fail)
          .finally(() => setSaving(false));
      }}
    >
      <Stack spacing="sm">
        <TextInput
          label="Key"
          description='Connection overlays, jobs, groups and workflows reference the environment by this key. Lowercase letters, digits, "-" and "_".'
          placeholder="staging"
          value={key}
          onChange={(e) => {
            setKey(e.currentTarget.value);
            setKeyError(null);
            setError(null);
          }}
          disabled={editing !== null}
          autoComplete="off"
          {...(editing === null && { 'data-autofocus': true })}
          {...(keyError !== null && { error: keyError })}
          required
        />
        <TextInput
          label="Display name"
          value={name}
          autoComplete="off"
          {...(editing !== null && { 'data-autofocus': true })}
          onChange={(e) => {
            setName(e.currentTarget.value);
            setError(null);
          }}
        />
        <Textarea
          label="Description"
          autosize
          minRows={2}
          value={description}
          onChange={(e) => {
            setDescription(e.currentTarget.value);
            setError(null);
          }}
        />
        {error !== null && (
          <Alert color="red" icon={<IconAlertCircle size={18} />} role="alert">
            {error}
          </Alert>
        )}
        <Group position="right">
          <Button type="submit" loading={saving}>
            {editing ? 'Save' : 'Create environment'}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

export function EnvironmentList() {
  const queryClient = useQueryClient();
  const environments = useEnvironments();
  const [editing, setEditing] = useState<EnvironmentDto | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<string | null>(null);
  const canCreate = useCan({ resource: 'environments', action: 'create' }).data?.can === true;
  const canEdit = useCan({ resource: 'environments', action: 'edit' }).data?.can === true;
  const canDelete = useCan({ resource: 'environments', action: 'delete' }).data?.can === true;
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ENVIRONMENTS_KEY });
  const remove = async (environment: EnvironmentDto) => {
    setDeleting(environment.key);
    try {
      await client.environments.delete({ key: environment.key });
      showNotification({
        color: 'teal',
        title: 'Environment deleted',
        message: `${environmentLabel(environment)} was removed.`,
      });
      refresh();
    } catch (error: unknown) {
      notifyError(`Couldn't delete ${environment.key}`, error);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <List
      title={<PageHeading>Environments</PageHeading>}
      breadcrumb={pageBreadcrumb}
      headerButtons={
        canCreate ? (
          <Button leftIcon={<IconPlus size={16} />} onClick={() => setEditing(null)}>
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
      {environments.isError ? (
        <LoadError
          error={environments.error}
          what="environments"
          onRetry={() => void environments.refetch()}
        />
      ) : (
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
              {(environments.data ?? []).map((environment) => (
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
                              onClick={() => setEditing(environment)}
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
                              loading={deleting === environment.key}
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
          {environments.data?.length === 0 && (
            <Text color="dimmed" p="lg" align="center">
              No environments yet.
              {canCreate &&
                ' Add staging or production to give connections per-environment overrides.'}
            </Text>
          )}
        </ScrollArea>
      )}
      <Modal
        opened={editing !== undefined}
        onClose={() => setEditing(undefined)}
        title={editing ? `Edit ${editing.key}` : 'Add environment'}
      >
        {editing !== undefined && (
          <EnvironmentForm
            key={editing?.key ?? 'new'}
            editing={editing}
            onSaved={(saved) => {
              showNotification({
                color: 'teal',
                title: editing ? 'Environment saved' : 'Environment created',
                message: editing
                  ? `${environmentLabel(saved)} was updated.`
                  : `${environmentLabel(saved)} is ready for connection overlays.`,
              });
              setEditing(undefined);
              refresh();
            }}
          />
        )}
      </Modal>
    </List>
  );
}
