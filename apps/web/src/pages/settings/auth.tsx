import { Alert, Button, Group, Loader, Stack, Text } from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { useLogout } from '@refinedev/core';
import { List } from '@refinedev/mantine';
import { IconLogout } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import {
  SignInMethodsFields,
  type SignInMethodsValue,
  fromAuthSettings,
  toAuthMethods,
} from '../../components/SignInMethods';
import { type AuthSettingsDto, client } from '../../lib/api';
import { configIssues, errorMessage, notifyError } from '../../lib/errors';
import { resetAuthConfig } from '../../lib/oidc';

const SETTINGS_KEY = ['auth-settings'];

function SettingsForm({ settings }: { settings: AuthSettingsDto }) {
  const queryClient = useQueryClient();
  const { mutate: logout } = useLogout();
  const [value, setValue] = useState<SignInMethodsValue>(() => fromAuthSettings(settings));
  const [saving, setSaving] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);
  const saved = (next: AuthSettingsDto) => {
    queryClient.setQueryData(SETTINGS_KEY, next);
    resetAuthConfig();
    void queryClient.invalidateQueries({ queryKey: ['auth', 'config'] });
  };
  const signOutEveryone = async () => {
    try {
      await client.authSettings.rotateSessionSecret({});
      logout();
    } catch (error: unknown) {
      notifyError('Could not sign everyone out', error);
    }
  };
  const save = async () => {
    setSaving(true);
    setIssues([]);
    try {
      saved(
        await client.authSettings.update({
          ...toAuthMethods(value),
          expectedVersion: settings.version,
        }),
      );
      showNotification({
        color: 'teal',
        title: 'Saved',
        message: 'Sign-in settings updated',
      });
    } catch (error: unknown) {
      const found = configIssues(error).map((i) => `${i.path}: ${i.message}`);
      setIssues(found.length > 0 ? found : [errorMessage(error)]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack spacing="lg">
      <SignInMethodsFields
        value={value}
        onChange={setValue}
        testOidc={(issuer) => client.setup.testOidc({ issuer })}
      />
      {issues.length > 0 && (
        <Alert color="red" title="These settings were not saved">
          {issues.map((issue) => (
            <Text key={issue} size="sm">
              {issue}
            </Text>
          ))}
        </Alert>
      )}
      <Group position="apart">
        <Button
          variant="default"
          color="red"
          leftIcon={<IconLogout size={16} />}
          onClick={() => void signOutEveryone()}
        >
          Sign out all password sessions
        </Button>
        <Button loading={saving} onClick={() => void save()}>
          Save
        </Button>
      </Group>
    </Stack>
  );
}

export function AuthSettingsPage() {
  const settings = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => client.authSettings.get({}),
  });

  return (
    <List title="Sign-in methods" canCreate={false}>
      {settings.data ? (
        <SettingsForm key={settings.data.version} settings={settings.data} />
      ) : settings.error ? (
        <Alert color="red">{errorMessage(settings.error)}</Alert>
      ) : (
        <Loader size="sm" />
      )}
    </List>
  );
}
