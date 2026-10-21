import { Alert, Badge, Button, Group, PasswordInput, Stack, Text, Title } from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { List } from '@refinedev/mantine';
import { useState } from 'react';

import { NewPasswordFields, passwordValid } from '../components/NewPasswordFields';
import { PageHeading } from '../components/page-chrome';
import {
  type IdentityDto,
  accessLevel,
  levelColor,
  levelDescription,
  useIdentity,
} from '../lib/access';
import { client } from '../lib/api';
import { errorMessage, focusFirstInvalidField, isUnauthorized } from '../lib/errors';
import { startPasswordSession } from '../providers/auth-provider';

const VIA_LABELS: Record<IdentityDto['via'], string> = {
  local: 'a username and password',
  oidc: 'single sign-on',
  api_key: 'an API key',
  anonymous: 'anonymous access',
};

function AccessSummary() {
  const { identity } = useIdentity();
  if (!identity) {
    return null;
  }
  const level = accessLevel(identity.scopes);

  return (
    <Stack spacing="xs">
      <Text size="sm">
        Signed in as <b>{identity.name}</b> with {VIA_LABELS[identity.via]}.
      </Text>
      <Group spacing="xs">
        <Text size="sm" weight={500}>
          Access:
        </Text>
        <Badge size="sm" variant="filled" color={levelColor(identity.scopes)} tt="none">
          {level}
        </Badge>
      </Group>
      <Text size="sm" color="dimmed">
        {levelDescription(identity.scopes)}
      </Text>
    </Stack>
  );
}

function ChangePasswordForm() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [currentError, setCurrentError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const currentProblem =
    currentError ?? (submitted && current === '' ? 'Enter your current password' : undefined);
  const submit = async (form: HTMLFormElement) => {
    setSubmitted(true);
    setCurrentError(null);
    setFailure(null);
    if (current === '' || !passwordValid(next, confirm)) {
      focusFirstInvalidField(form);

      return;
    }
    setSaving(true);
    try {
      startPasswordSession(
        await client.auth.changePassword({ currentPassword: current, newPassword: next }),
      );
      setCurrent('');
      setNext('');
      setConfirm('');
      setSubmitted(false);
      showNotification({
        color: 'teal',
        title: 'Password changed',
        message: 'Your other sessions were signed out.',
      });
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        setCurrentError(errorMessage(error));
        focusFirstInvalidField(form);
      } else {
        setFailure(errorMessage(error));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit(e.currentTarget);
      }}
    >
      <Stack spacing="sm">
        <Title order={3} size="h4">
          Change password
        </Title>
        <PasswordInput
          label="Current password"
          autoComplete="current-password"
          toggleTabIndex={0}
          value={current}
          onChange={(e) => {
            setCurrentError(null);
            setCurrent(e.currentTarget.value);
          }}
          {...(currentProblem === undefined ? {} : { error: currentProblem })}
          withAsterisk
        />
        <NewPasswordFields
          password={next}
          onPasswordChange={setNext}
          confirm={confirm}
          onConfirmChange={setConfirm}
          submitted={submitted}
        />
        {failure && (
          <Alert color="red" title="Password not changed" role="alert">
            {failure}
          </Alert>
        )}
        <Group position="right">
          <Button type="submit" loading={saving}>
            Change password
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

export function AccountPage() {
  const { identity } = useIdentity();
  const local = identity?.via === 'local';

  return (
    <List title={<PageHeading>Your account</PageHeading>} canCreate={false}>
      <Stack spacing="xl" maw={520}>
        <AccessSummary />
        {identity &&
          (local ? (
            <ChangePasswordForm />
          ) : (
            <Alert color="gray">
              You signed in with {VIA_LABELS[identity.via]}, so there is no password to change here.
            </Alert>
          ))}
      </Stack>
    </List>
  );
}
