import {
  Alert,
  Anchor,
  Button,
  Collapse,
  Divider,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import {
  useGetIdentity,
  useGo,
  useInvalidateAuthStore,
  useLogin,
  useParsed,
} from '@refinedev/core';
import { IconAlertCircle, IconKey } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Navigate } from 'react-router';

import { AuthShell, BrandMark, useFocusOnMount } from '../components/Brand';
import { errorMessage } from '../lib/errors';
import { authConfig } from '../lib/oidc';

type LoginVariables =
  | { username: string; password: string }
  | { apiKey: string }
  | { method: 'oidc' };

type Method = 'password' | 'key' | 'oidc';

const methodOf = (variables: LoginVariables): Method =>
  'username' in variables ? 'password' : 'apiKey' in variables ? 'key' : 'oidc';

function PasswordForm({
  login,
  pending,
  failed,
  onEdit,
}: {
  login: (variables: LoginVariables) => void;
  pending: boolean;
  failed: boolean;
  onEdit: () => void;
}) {
  const focusRef = useFocusOnMount<HTMLInputElement>();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const usernameError = submitted && username.trim() === '' ? 'Enter your username' : undefined;
  const passwordError = submitted && password === '' ? 'Enter your password' : undefined;

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setSubmitted(true);
        if (username.trim() === '' || password === '') {
          return;
        }
        login({ username, password });
      }}
    >
      <Stack spacing="sm">
        <TextInput
          label="Username"
          autoComplete="username"
          ref={focusRef}
          value={username}
          onChange={(e) => {
            onEdit();
            setUsername(e.currentTarget.value);
          }}
          error={usernameError ?? failed}
        />
        <PasswordInput
          label="Password"
          autoComplete="current-password"
          toggleTabIndex={0}
          value={password}
          onChange={(e) => {
            onEdit();
            setPassword(e.currentTarget.value);
          }}
          error={passwordError ?? failed}
        />
        <Button type="submit" loading={pending}>
          Sign in
        </Button>
      </Stack>
    </form>
  );
}

function ApiKeyForm({
  login,
  pending,
  failed,
  onEdit,
  primary,
}: {
  login: (variables: LoginVariables) => void;
  pending: boolean;
  failed: boolean;
  onEdit: () => void;
  primary: boolean;
}) {
  const focusRef = useFocusOnMount<HTMLInputElement>();
  const [apiKey, setApiKey] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const keyError = submitted && apiKey.trim() === '' ? 'Paste your API key' : undefined;

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setSubmitted(true);
        if (apiKey.trim() === '') {
          return;
        }
        login({ apiKey });
      }}
    >
      <Stack spacing="sm">
        <Text size="sm" color="dimmed">
          Paste an API key issued by your administrator. It stays in this browser only.
        </Text>
        <PasswordInput
          label="API key"
          autoComplete="off"
          ref={primary ? focusRef : undefined}
          toggleTabIndex={0}
          value={apiKey}
          onChange={(e) => {
            onEdit();
            setApiKey(e.currentTarget.value);
          }}
          error={keyError ?? failed}
        />
        <Button type="submit" variant={primary ? 'filled' : 'default'} loading={pending}>
          Sign in with key
        </Button>
      </Stack>
    </form>
  );
}

export function Login() {
  const [method, setMethod] = useState<Method>('password');
  const [failure, setFailure] = useState<{ method: Method; message: string } | null>(null);
  const [showKey, setShowKey] = useState(false);
  const go = useGo();
  const parsed = useParsed();
  const invalidateAuth = useInvalidateAuthStore();
  const { mutate, isPending } = useLogin<LoginVariables>({
    mutationOptions: {
      onSuccess: async ({ success, redirectTo, error }, variables) => {
        if (!success) {
          setFailure({
            method: methodOf(variables),
            message: error?.message ?? 'Sign in failed. Check your details and try again.',
          });

          return;
        }
        await invalidateAuth();
        const target: unknown = parsed.params?.['to'];
        const to = typeof target === 'string' ? target : redirectTo;
        if (to !== undefined) {
          go({ to, type: 'replace' });
        }
      },
      onError: (error, variables) =>
        setFailure({ method: methodOf(variables), message: errorMessage(error) }),
    },
  });
  const config = useQuery({
    queryKey: ['auth', 'config'],
    queryFn: authConfig,
    staleTime: Infinity,
  });
  const identity = useGetIdentity<{ via: string }>();
  if (config.data?.setupRequired === true) {
    return <Navigate to="/setup" replace />;
  }
  if (identity.data && identity.data.via !== 'anonymous') {
    return <Navigate to="/" replace />;
  }
  const sso = config.data?.oidc !== null && config.data?.oidc !== undefined;
  const local = config.data?.local !== false;
  const keys = config.data?.apiKeys !== false || (!local && !sso);
  const keyOnly = !sso && !local;
  const login = (variables: LoginVariables) => {
    setFailure(null);
    setMethod(methodOf(variables));
    mutate(variables);
  };
  const clearFailure = () => setFailure(null);
  const failedWith = (m: Method) => failure?.method === m;

  return (
    <AuthShell>
      <BrandMark size={32} />
      <Title order={1} size="h3">
        Sign in to Cloud Trigger
      </Title>
      {failure && (
        <Alert color="red" icon={<IconAlertCircle size={16} />} title="Sign in failed" role="alert">
          {failure.message}
        </Alert>
      )}
      {sso && (
        <Button
          leftIcon={<IconKey size={16} />}
          loading={isPending && method === 'oidc'}
          variant={local ? 'default' : 'filled'}
          onClick={() => login({ method: 'oidc' })}
        >
          Sign in with SSO
        </Button>
      )}
      {sso && local && <Divider label="or with your password" labelPosition="center" />}
      {local && (
        <PasswordForm
          login={login}
          pending={isPending && method === 'password'}
          failed={failedWith('password')}
          onEdit={clearFailure}
        />
      )}
      {keys && keyOnly && (
        <ApiKeyForm
          login={login}
          pending={isPending && method === 'key'}
          failed={failedWith('key')}
          onEdit={clearFailure}
          primary
        />
      )}
      {keys && !keyOnly && (
        <>
          <Anchor
            component="button"
            type="button"
            size="sm"
            align="center"
            aria-expanded={showKey}
            onClick={() => setShowKey((open) => !open)}
          >
            {showKey ? 'Hide API key sign-in' : 'Use an API key instead'}
          </Anchor>
          <Collapse in={showKey}>
            {showKey && (
              <ApiKeyForm
                login={login}
                pending={isPending && method === 'key'}
                failed={failedWith('key')}
                onEdit={clearFailure}
                primary={false}
              />
            )}
          </Collapse>
        </>
      )}
    </AuthShell>
  );
}
