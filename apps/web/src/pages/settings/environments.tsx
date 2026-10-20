import {
  ActionIcon,
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
import { List } from '@refinedev/mantine';
import { IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { type EnvironmentDto, client } from '../../lib/api';
import { ENVIRONMENTS_KEY, useEnvironments } from '../../lib/environments';
import { errorMessage, notifyError } from '../../lib/errors';

function EnvironmentForm({
  editing,
  onSaved,
}: {
  editing: EnvironmentDto | null;
  onSaved: () => void;
}) {
  const [key, setKey] = useState(editing?.key ?? '');
  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = () => {
    const spec = { key: key.trim(), name, description };

    return editing
      ? client.environments.update({ ...spec, expectedVersion: editing.version })
      : client.environments.create(spec);
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setSaving(true);
        save()
          .then(onSaved)
          .catch((failure: unknown) => setError(errorMessage(failure)))
          .finally(() => setSaving(false));
      }}
    >
      <Stack spacing="sm">
        <TextInput
          label="Key"
          description="Connection overlays, jobs, groups and workflows reference the environment by this key."
          placeholder="staging"
          value={key}
          onChange={(e) => setKey(e.currentTarget.value)}
          disabled={editing !== null}
          {...(error ? { error } : {})}
          required
        />
        <TextInput
          label="Display name"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
        <Textarea
          label="Description"
          autosize
          minRows={2}
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
        />
        <Group position="right">
          <Button type="submit" loading={saving} disabled={key.trim() === ''}>
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
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ENVIRONMENTS_KEY });
  const remove = async (environment: EnvironmentDto) => {
    try {
      await client.environments.delete({ key: environment.key });
      showNotification({ color: 'teal', title: 'Deleted', message: `${environment.key} removed` });
      refresh();
    } catch (error: unknown) {
      notifyError('Not deleted', error);
    }
  };

  return (
    <List
      title="Environments"
      headerButtons={
        <Button leftIcon={<IconPlus size={16} />} onClick={() => setEditing(null)}>
          Add environment
        </Button>
      }
    >
      <Text size="sm" color="dimmed" mb="md">
        A connection can override its address, credentials and endpoints per environment. Jobs,
        groups and workflows pick the environment they run in; without one they use the base
        connection config.
      </Text>
      <ScrollArea>
        <Table highlightOnHover verticalSpacing="xs" className="ct-table" miw={560}>
          <thead>
            <tr>
              <th>Key</th>
              <th>Name</th>
              <th>Description</th>
              <th aria-label="Actions" />
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
                <td>
                  <Group position="right" spacing={4} noWrap>
                    <Tooltip label="Edit">
                      <ActionIcon onClick={() => setEditing(environment)} aria-label="Edit">
                        <IconPencil size={16} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Delete">
                      <ActionIcon
                        color="red"
                        onClick={() => void remove(environment)}
                        aria-label="Delete"
                      >
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
        {environments.data?.length === 0 && (
          <Text color="dimmed" p="lg" align="center">
            No environments yet. Add staging or production to give connections per-environment
            overrides.
          </Text>
        )}
      </ScrollArea>
      <Modal
        opened={editing !== undefined}
        onClose={() => setEditing(undefined)}
        title={editing ? `Edit ${editing.key}` : 'Add environment'}
      >
        {editing !== undefined && (
          <EnvironmentForm
            key={editing?.key ?? 'new'}
            editing={editing}
            onSaved={() => {
              setEditing(undefined);
              refresh();
            }}
          />
        )}
      </Modal>
    </List>
  );
}
