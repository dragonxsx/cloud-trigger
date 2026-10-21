import { Alert, Button, Divider, Group, Stack, Text, Title } from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { useLogout, useWarnAboutChange } from '@refinedev/core';
import { List } from '@refinedev/mantine';
import { IconLogout } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { confirmAction, confirmed } from '../../components/confirm';
import { PageHeading, pageBreadcrumb } from '../../components/page-chrome';
import { PageLoader, LoadError } from '../../components/PageState';
import {
  type MethodErrors,
  SignInMethodsFields,
  type SignInMethodsValue,
  fromAuthSettings,
  methodField,
  methodsErrors,
  toAuthMethods,
} from '../../components/SignInMethods';
import { topScope } from '../../lib/access';
import { type AuthSettingsDto, client } from '../../lib/api';
import { configIssues, errorMessage, focusFirstInvalidField, notifyError } from '../../lib/errors';
import { resetAuthConfig } from '../../lib/oidc';

const SETTINGS_KEY = ['auth-settings'];

const snapshot = (value: SignInMethodsValue): string => JSON.stringify(toAuthMethods(value));

function SettingsForm({ settings }: { settings: AuthSettingsDto }) {
  const queryClient = useQueryClient();
  const { mutate: logout } = useLogout();
  const { setWarnWhen } = useWarnAboutChange();
  const initial = fromAuthSettings(settings);
  const [value, setValue] = useState<SignInMethodsValue>(initial);
  const [saving, setSaving] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<MethodErrors>({});
  const [issues, setIssues] = useState<string[]>([]);
  const dirty = snapshot(value) !== snapshot(initial);
  const errors = { ...(submitted ? methodsErrors(value) : {}), ...serverErrors };

  useEffect(() => {
    setWarnWhen(dirty);
  }, [dirty, setWarnWhen]);
  useEffect(() => () => setWarnWhen(false), [setWarnWhen]);

  const change = (next: SignInMethodsValue) => {
    setServerErrors({});
    setValue(next);
  };
  const saved = (next: AuthSettingsDto) => {
    setWarnWhen(false);
    queryClient.setQueryData(SETTINGS_KEY, next);
    resetAuthConfig();
    void queryClient.invalidateQueries({ queryKey: ['auth', 'config'] });
  };
  const signOutEveryone = async () => {
    setSigningOut(true);
    try {
      await client.authSettings.rotateSessionSecret({});
      logout();
    } catch (error: unknown) {
      notifyError("Couldn't sign everyone out", error);
    } finally {
      setSigningOut(false);
    }
  };
  const save = async () => {
    setSubmitted(true);
    setIssues([]);
    setServerErrors({});
    if (Object.keys(methodsErrors(value)).length > 0) {
      focusFirstInvalidField();

      return;
    }
    const grantsAdmin =
      topScope(value.anonymousScopes) === 'admin' &&
      topScope(settings.anonymous.scopes) !== 'admin';
    if (
      grantsAdmin &&
      !(await confirmed({
        title: 'Give anonymous visitors full control?',
        message:
          'Anyone who can reach this server will be able to manage users, API keys and sign-in methods without signing in.',
        confirmLabel: 'Give full control',
      }))
    ) {
      return;
    }
    setSaving(true);
    try {
      saved(
        await client.authSettings.update({
          ...toAuthMethods(value),
          expectedVersion: settings.version,
        }),
      );
      showNotification({
        color: 'teal',
        title: 'Sign-in settings saved',
        message: 'New sign-ins use these settings right away.',
      });
    } catch (error: unknown) {
      const found = configIssues(error);
      const mapped: Record<string, string> = {};
      const other: string[] = [];
      for (const issue of found) {
        const field = methodField(issue.path);
        if (field === undefined) {
          other.push(issue.message);
        } else {
          mapped[field] = issue.message;
        }
      }
      setServerErrors(mapped);
      setIssues(found.length > 0 ? other : [errorMessage(error)]);
      focusFirstInvalidField();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack spacing="lg">
      <SignInMethodsFields
        value={value}
        onChange={change}
        testOidc={(issuer) => client.setup.testOidc({ issuer })}
        errors={errors}
      />
      {issues.length > 0 && (
        <Alert color="red" title="These settings were not saved" role="alert">
          {issues.map((issue) => (
            <Text key={issue} size="sm">
              {issue}
            </Text>
          ))}
        </Alert>
      )}
      <Group position="right" spacing="xs">
        {dirty && (
          <Text size="sm" color="dimmed" mr="auto">
            You have unsaved changes.
          </Text>
        )}
        <Button
          variant="default"
          disabled={!dirty || saving}
          onClick={() => {
            setValue(initial);
            setSubmitted(false);
            setServerErrors({});
            setIssues([]);
          }}
        >
          Discard changes
        </Button>
        <Button loading={saving} disabled={!dirty} onClick={() => void save()}>
          Save changes
        </Button>
      </Group>
      <Divider />
      <Stack spacing="xs">
        <Title order={4} color="red">
          Danger zone
        </Title>
        <Group position="apart" align="flex-start" spacing="md">
          <Text size="sm" color="dimmed" maw={520}>
            Ends every password session, including yours. Everyone signs in again; API keys and SSO
            tokens keep working.
          </Text>
          <Button
            variant="outline"
            color="red"
            leftIcon={<IconLogout size={16} />}
            loading={signingOut}
            onClick={() =>
              void confirmAction({
                title: 'Sign out all password sessions?',
                message:
                  'Everyone who signed in with a password is signed out, including you. You will need to sign in again.',
                confirmLabel: 'Sign everyone out',
                onConfirm: signOutEveryone,
              })
            }
          >
            Sign out all password sessions
          </Button>
        </Group>
      </Stack>
    </Stack>
  );
}

export function AuthSettingsPage() {
  const settings = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => client.authSettings.get({}),
  });

  return (
    <List
      title={<PageHeading>Sign-in methods</PageHeading>}
      breadcrumb={pageBreadcrumb}
      canCreate={false}
    >
      {settings.data ? (
        <SettingsForm key={settings.data.version} settings={settings.data} />
      ) : settings.error ? (
        <LoadError
          error={settings.error}
          what="sign-in settings"
          onRetry={() => void settings.refetch()}
        />
      ) : (
        <PageLoader label="Loading sign-in settings…" />
      )}
    </List>
  );
}
