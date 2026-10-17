import { Button, Center, PasswordInput, Stack, Text, Title } from '@mantine/core';
import { useLogin } from '@refinedev/core';
import { useState } from 'react';

import { BrandMark } from '../components/Brand';

export function Login() {
  const [apiKey, setApiKey] = useState('');
  const { mutate: login, isPending, error } = useLogin<{ apiKey: string }>();

  return (
    <Center h="100vh" style={{ background: 'var(--ct-paper)' }}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          login({ apiKey });
        }}
      >
        <Stack w={360} className="ct-panel" p="xl" spacing="md">
          <BrandMark size={32} />
          <Title order={3}>Sign in to Cloud Trigger</Title>
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
          <Button type="submit" loading={isPending} disabled={apiKey.trim() === ''}>
            Sign in
          </Button>
        </Stack>
      </form>
    </Center>
  );
}
