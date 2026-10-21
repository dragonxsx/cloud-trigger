import { Alert, Badge, Button, Group, PasswordInput, Stack, Text, Title } from '@mantine/core';
import { useNotification, useUpdatePassword } from '@refinedev/core';
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
import { errorMessage, errorStatus, focusFirstInvalidField } from '../lib/errors';

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

interface PasswordChange {
  readonly currentPassword: string;
  readonly newPassword: string;
}

function ChangePasswordForm() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [currentError, setCurrentError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const { open } = useNotification();
  const { mutate: updatePassword, isPending } = useUpdatePassword<PasswordChange>({
    mutationOptions: {
      onSuccess: ({ successNotification }) => {
        if (successNotification) {
          open?.({
            type: 'success',
            key: 'update-password-success',
            message: successNotification.message,
            ...(successNotification.description === undefined
              ? {}
              : { description: successNotification.description }),
          });
        }
      },
    },
  });
  const currentProblem =
    currentError ?? (submitted && current === '' ? 'Enter your current password' : undefined);
  const submit = (form: HTMLFormElement) => {
    setSubmitted(true);
    setCurrentError(null);
    setFailure(null);
    if (current === '' || !passwordValid(next, confirm)) {
      focusFirstInvalidField(form);

      return;
    }
    updatePassword(
      { currentPassword: current, newPassword: next },
      {
        onSuccess: ({ success, error }) => {
          if (success) {
            setCurrent('');
            setNext('');
            setConfirm('');
            setSubmitted(false);
          } else if (errorStatus(error) === 401) {
            setCurrentError(errorMessage(error));
            focusFirstInvalidField(form);
          } else {
            setFailure(errorMessage(error));
          }
        },
      },
    );
  };

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit(e.currentTarget);
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
          <Button type="submit" loading={isPending}>
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
