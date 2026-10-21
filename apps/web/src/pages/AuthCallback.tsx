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
import { useGo, useInvalidateAuthStore } from '@refinedev/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';

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
  const go = useGo();
  const invalidateAuth = useInvalidateAuthStore();
  const [failure, setFailure] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;
    const finish = async () => {
      try {
        await completeSignIn();
        await invalidateAuth();
        go({ to: '/', type: 'replace' });
      } catch (error: unknown) {
        setFailure(errorMessage(error));
      }
    };
    void finish();
  }, [go, invalidateAuth]);

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
