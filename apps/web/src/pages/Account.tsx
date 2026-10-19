import { Alert, Button, Group, PasswordInput, Stack, Text } from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { useGetIdentity } from '@refinedev/core';
import { List } from '@refinedev/mantine';
import { useState } from 'react';

import { client } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { startPasswordSession } from '../providers/auth-provider';

const MIN_PASSWORD = 12;

export function AccountPage() {
  const identity = useGetIdentity<{ name: string; via: string }>();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const local = identity.data?.via === 'local';
  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      startPasswordSession(
        await client.auth.changePassword({ currentPassword: current, newPassword: next }),
      );
      setCurrent('');
      setNext('');
      setConfirm('');
      showNotification({
        color: 'teal',
        title: 'Password changed',
        message: 'Your other sessions were signed out',
      });
    } catch (failure: unknown) {
      setError(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <List title="Your account" canCreate={false}>
      <Stack spacing="md" maw={420}>
        <Text size="sm">
          Signed in as <b>{identity.data?.name}</b>
        </Text>
        {!local ? (
          <Alert color="gray">
            You signed in with SSO or an API key, so there is no password to change here.
          </Alert>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <Stack spacing="sm">
              <PasswordInput
                label="Current password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.currentTarget.value)}
                {...(error ? { error } : {})}
                required
              />
              <PasswordInput
                label="New password"
                description={`At least ${MIN_PASSWORD} characters.`}
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.currentTarget.value)}
                required
              />
              <PasswordInput
                label="Confirm new password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.currentTarget.value)}
                {...(confirm && confirm !== next ? { error: 'The passwords differ' } : {})}
                required
              />
              <Group position="right">
                <Button
                  type="submit"
                  loading={saving}
                  disabled={!current || next.length < MIN_PASSWORD || next !== confirm}
                >
                  Change password
                </Button>
              </Group>
            </Stack>
          </form>
        )}
      </Stack>
    </List>
  );
}
