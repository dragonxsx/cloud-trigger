import { Alert, Anchor, Center, Loader, Stack } from '@mantine/core';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { errorMessage } from '../lib/errors';
import { completeSignIn } from '../lib/oidc';

export function AuthCallback() {
  const navigate = useNavigate();
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    const finish = async () => {
      try {
        await completeSignIn();
        await navigate('/', { replace: true });
      } catch (error: unknown) {
        setFailure(errorMessage(error));
      }
    };
    void finish();
  }, [navigate]);

  return (
    <Center h="100vh">
      {failure ? (
        <Stack w={360}>
          <Alert color="red" title="Sign in failed">
            {failure}
          </Alert>
          <Anchor component={Link} to="/login">
            Back to sign in
          </Anchor>
        </Stack>
      ) : (
        <Loader />
      )}
    </Center>
  );
}
