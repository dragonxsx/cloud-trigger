import { Button, Center, Divider, PasswordInput, Stack, Text, Title } from '@mantine/core';
import { useGetIdentity, useLogin } from '@refinedev/core';
import { IconKey } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Navigate } from 'react-router';

import { BrandMark } from '../components/Brand';
import { authConfig } from '../lib/oidc';

type LoginVariables = { apiKey: string } | { method: 'oidc' };

export function Login() {
  const [apiKey, setApiKey] = useState('');
  const { mutate: login, isPending, error } = useLogin<LoginVariables>();
  const config = useQuery({
    queryKey: ['auth', 'config'],
    queryFn: authConfig,
    staleTime: Infinity,
  });
  const sso = config.data?.oidc !== null && config.data?.oidc !== undefined;
  const showKeys = !sso || config.data?.apiKeys !== false;
  const identity = useGetIdentity<{ via: string }>();
  if (identity.data && identity.data.via !== 'anonymous') {
    return <Navigate to="/" replace />;
  }

  return (
    <Center h="100vh" style={{ background: 'var(--ct-paper)' }}>
      <Stack w={360} className="ct-panel" p="xl" spacing="md">
        <BrandMark size={32} />
        <Title order={3}>Sign in to Cloud Trigger</Title>
        {sso && (
          <Button
            leftIcon={<IconKey size={16} />}
            loading={isPending}
            onClick={() => login({ method: 'oidc' })}
          >
            Sign in with SSO
          </Button>
        )}
        {sso && showKeys && <Divider label="or use an API key" labelPosition="center" />}
        {showKeys && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              login({ apiKey });
            }}
          >
            <Stack spacing="md">
              <Text size="sm" color="dimmed">
                Paste an API key issued by your administrator. It stays in this browser only.
              </Text>
              <PasswordInput
                label="API key"
                value={apiKey}
                onChange={(e) => setApiKey(e.currentTarget.value)}
                {...(error ? { error: error.message } : {})}
                required
              />
              <Button
                type="submit"
                variant={sso ? 'default' : 'filled'}
                loading={isPending}
                disabled={apiKey.trim() === ''}
              >
                Sign in with key
              </Button>
            </Stack>
          </form>
        )}
      </Stack>
    </Center>
  );
}
