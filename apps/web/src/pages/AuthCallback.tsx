import {
  Alert,
  Anchor,
  Button,
  Code,
  Collapse,
  Group,
  Loader,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { AuthShell, BrandMark } from '../components/Brand';
import { errorMessage } from '../lib/errors';
import { completeSignIn } from '../lib/oidc';

function SignInFailed({ detail }: { detail: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Stack spacing="sm">
      <Alert color="red" icon={<IconAlertCircle size={16} />} title="Sign in failed" role="alert">
        We couldn&apos;t finish signing you in with single sign-on. Try again. If it keeps
        happening, ask your administrator to check the SSO settings.
      </Alert>
      <Anchor
        component="button"
        type="button"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? 'Hide technical details' : 'Show technical details'}
      </Anchor>
      <Collapse in={open}>
        <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {detail}
        </Code>
      </Collapse>
      <Group position="right">
        <Button component={Link} to="/login">
          Back to sign in
        </Button>
      </Group>
    </Stack>
  );
}

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
    <AuthShell>
      <BrandMark size={32} />
      <Title order={1} size="h3">
        {failure === null ? 'Finishing sign-in…' : "Couldn't sign you in"}
      </Title>
      {failure === null ? (
        <Group spacing="sm" aria-live="polite">
          <Loader size="sm" />
          <Text size="sm" color="dimmed">
            Checking your identity provider&apos;s response.
          </Text>
        </Group>
      ) : (
        <SignInFailed detail={failure} />
      )}
    </AuthShell>
  );
}
