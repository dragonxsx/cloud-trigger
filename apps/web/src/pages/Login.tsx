import {
  Button,
  Center,
  Divider,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useGetIdentity, useLogin } from '@refinedev/core';
import { IconKey } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Navigate } from 'react-router';

import { BrandMark } from '../components/Brand';
import { authConfig } from '../lib/oidc';

type LoginVariables =
  | { username: string; password: string }
  | { apiKey: string }
  | { method: 'oidc' };

function PasswordForm({
  login,
  pending,
  error,
}: {
  login: (variables: LoginVariables) => void;
  pending: boolean;
  error: string | undefined;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        login({ username, password });
      }}
    >
      <Stack spacing="sm">
        <TextInput
          label="Username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.currentTarget.value)}
          required
        />
        <PasswordInput
          label="Password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
          {...(error ? { error } : {})}
          required
        />
        <Button type="submit" loading={pending} disabled={username.trim() === '' || !password}>
          Sign in
        </Button>
      </Stack>
    </form>
  );
}

function ApiKeyForm({
  login,
  pending,
  error,
  primary,
}: {
  login: (variables: LoginVariables) => void;
  pending: boolean;
  error: string | undefined;
  primary: boolean;
}) {
  const [apiKey, setApiKey] = useState('');

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        login({ apiKey });
      }}
    >
      <Stack spacing="sm">
        <Text size="sm" color="dimmed">
          Paste an API key issued by your administrator. It stays in this browser only.
        </Text>
        <PasswordInput
          label="API key"
          value={apiKey}
          onChange={(e) => setApiKey(e.currentTarget.value)}
          {...(error ? { error } : {})}
          required
        />
        <Button
          type="submit"
          variant={primary ? 'filled' : 'default'}
          loading={pending}
          disabled={apiKey.trim() === ''}
        >
          Sign in with key
        </Button>
      </Stack>
    </form>
  );
}

export function Login() {
  const [method, setMethod] = useState<'password' | 'key' | 'oidc'>('password');
  const { mutate, isPending, error } = useLogin<LoginVariables>();
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
  const login = (variables: LoginVariables) => {
    setMethod('username' in variables ? 'password' : 'apiKey' in variables ? 'key' : 'oidc');
    mutate(variables);
  };
  const errorFor = (m: typeof method) => (error && method === m ? error.message : undefined);

  return (
    <Center mih="100vh" p="md" style={{ background: 'var(--ct-paper)' }}>
      <Stack w="100%" maw={380} className="ct-panel" p="xl" spacing="md">
        <BrandMark size={32} />
        <Title order={3}>Sign in to Cloud Trigger</Title>
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
            error={errorFor('password')}
          />
        )}
        {keys && (sso || local) && <Divider label="or use an API key" labelPosition="center" />}
        {keys && (
          <ApiKeyForm
            login={login}
            pending={isPending && method === 'key'}
            error={errorFor('key')}
            primary={!sso && !local}
          />
        )}
      </Stack>
    </Center>
  );
}
