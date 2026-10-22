import { Alert, Button, Divider, Group, Stack, Text, Title } from '@mantine/core';
import { useForm } from '@mantine/form';
import { useLogout, useNotification, useWarnAboutChange } from '@refinedev/core';
import { List } from '@refinedev/mantine';
import { IconLogout } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { confirmAction, confirmed } from '../../components/confirm';
import { PageHeading, pageBreadcrumb } from '../../components/page-chrome';
import { PageLoader, LoadError } from '../../components/PageState';
import {
  SignInMethodsFields,
  type SignInMethodsValue,
  fromAuthSettings,
  methodField,
  methodsErrors,
  toAuthMethods,
} from '../../components/SignInMethods';
import { topScope } from '../../lib/access';
import { type AuthSettingsDto, client, orpc } from '../../lib/api';
import { configIssues, errorMessage, focusFirstInvalidField, notifyError } from '../../lib/errors';
import { resetAuthConfig } from '../../lib/oidc';

function SettingsForm({ settings }: { settings: AuthSettingsDto }) {
  const queryClient = useQueryClient();
  const { mutate: logout } = useLogout();
  const { setWarnWhen } = useWarnAboutChange();
  const { open } = useNotification();
  const form = useForm<SignInMethodsValue>({ initialValues: fromAuthSettings(settings) });
  const value = form.values;
  const [saving, setSaving] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);
  const dirty = form.isDirty();
  const errors = {
    ...(submitted ? methodsErrors(value) : {}),
    ...Object.fromEntries(
      Object.entries(form.errors).flatMap(([path, message]) =>
        typeof message === 'string' ? [[path, message]] : [],
      ),
    ),
  };

  useEffect(() => {
    setWarnWhen(dirty);
  }, [dirty, setWarnWhen]);
  useEffect(() => () => setWarnWhen(false), [setWarnWhen]);

  const saved = (next: AuthSettingsDto) => {
    const values = fromAuthSettings(next);
    form.setValues(values);
    form.resetDirty(values);
    setWarnWhen(false);
    queryClient.setQueryData(orpc.authSettings.get.queryKey({ input: {} }), next);
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
    form.clearErrors();
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
      open?.({
        type: 'success',
        message: 'Sign-in settings saved',
        description: 'New sign-ins use these settings right away.',
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
      form.setErrors(mapped);
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
        onChange={form.setValues}
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
            form.reset();
            setSubmitted(false);
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
  const settings = useQuery(orpc.authSettings.get.queryOptions({ input: {} }));

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
