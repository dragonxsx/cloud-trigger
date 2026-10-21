import { PasswordInput, Stack } from '@mantine/core';

export const MIN_PASSWORD = 12;

export const passwordError = (password: string, submitted: boolean): string | undefined => {
  if (password === '') {
    return submitted ? 'Enter a password' : undefined;
  }

  return password.length < MIN_PASSWORD
    ? `Use at least ${String(MIN_PASSWORD)} characters (${String(password.length)} so far)`
    : undefined;
};

export const confirmError = (
  password: string,
  confirm: string,
  submitted: boolean,
): string | undefined => {
  if (confirm === '') {
    return submitted ? 'Type the password again' : undefined;
  }

  return confirm === password ? undefined : 'The passwords differ';
};

export const passwordValid = (password: string, confirm?: string): boolean =>
  passwordError(password, true) === undefined &&
  (confirm === undefined || confirmError(password, confirm, true) === undefined);

export function NewPasswordFields({
  label = 'New password',
  description = `At least ${String(MIN_PASSWORD)} characters.`,
  password,
  onPasswordChange,
  confirm,
  onConfirmChange,
  submitted,
}: {
  readonly label?: string;
  readonly description?: string;
  readonly password: string;
  readonly onPasswordChange: (password: string) => void;
  readonly confirm?: string | undefined;
  readonly onConfirmChange?: ((confirm: string) => void) | undefined;
  readonly submitted: boolean;
}) {
  const passwordProblem = passwordError(password, submitted);
  const confirmProblem =
    confirm === undefined ? undefined : confirmError(password, confirm, submitted);

  return (
    <Stack spacing="sm">
      <PasswordInput
        label={label}
        description={description}
        autoComplete="new-password"
        toggleTabIndex={0}
        value={password}
        onChange={(e) => onPasswordChange(e.currentTarget.value)}
        {...(passwordProblem === undefined ? {} : { error: passwordProblem })}
        withAsterisk
      />
      {confirm !== undefined && onConfirmChange && (
        <PasswordInput
          label={`Confirm ${label.toLowerCase()}`}
          autoComplete="new-password"
          toggleTabIndex={0}
          value={confirm}
          onChange={(e) => onConfirmChange(e.currentTarget.value)}
          {...(confirmProblem === undefined ? {} : { error: confirmProblem })}
          withAsterisk
        />
      )}
    </Stack>
  );
}
