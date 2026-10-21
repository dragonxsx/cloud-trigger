import { Alert, Button, Center, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { IconAlertTriangle, IconLock, IconSearch } from '@tabler/icons-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';

import { errorMessage, isForbidden, isNotFound } from '../lib/errors';
import { usePageTitle } from './usePageTitle';

const SLOW_AFTER_MS = 8_000;

export function PageLoader({ label = 'Loading…' }: { label?: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), SLOW_AFTER_MS);

    return () => window.clearTimeout(timer);
  }, []);

  return (
    <Center mih={240}>
      <Stack align="center" spacing="xs" maw={420}>
        <Loader size="sm" />
        <Text size="sm" color="dimmed" align="center" aria-live="polite">
          {slow
            ? 'Still loading. If this keeps happening, reload the page or close other Cloud Trigger tabs.'
            : label}
        </Text>
      </Stack>
    </Center>
  );
}

interface LinkAction {
  readonly to: string;
  readonly label: string;
}

interface StatePanelProps {
  readonly icon: ReactNode;
  readonly color: string;
  readonly title: string;
  readonly children: ReactNode;
  readonly actions?: readonly LinkAction[];
  readonly onRetry?: (() => void) | undefined;
}

function StatePanel({ icon, color, title, children, actions = [], onRetry }: StatePanelProps) {
  return (
    <Alert icon={icon} color={color} title={title} role="alert" maw={640} my="md">
      <Stack spacing="sm">
        <Text size="sm">{children}</Text>
        {(actions.length > 0 || onRetry) && (
          <Group spacing="xs">
            {onRetry && (
              <Button size="xs" variant="filled" color={color} onClick={onRetry}>
                Try again
              </Button>
            )}
            {actions.map((action, index) => (
              <Button
                key={action.to}
                component={Link}
                to={action.to}
                size="xs"
                variant={index === 0 && !onRetry ? 'filled' : 'default'}
                color={color}
              >
                {action.label}
              </Button>
            ))}
          </Group>
        )}
      </Stack>
    </Alert>
  );
}

export interface RecordStateProps {
  readonly resource: string;
  readonly listPath: string;
  readonly listLabel: string;
}

export function RecordNotFound({ resource, listPath, listLabel }: RecordStateProps) {
  usePageTitle(`${resource} not found`);

  return (
    <StatePanel
      icon={<IconSearch size={18} />}
      color="gray"
      title={`${resource} not found`}
      actions={[{ to: listPath, label: `Back to ${listLabel.toLowerCase()}` }]}
    >
      {`This ${resource.toLowerCase()} doesn't exist, or it was deleted. Check the link, or find it in the list.`}
    </StatePanel>
  );
}

const VIEW_ACTIONS: ReadonlySet<string> = new Set(['list', 'show']);

export function AccessDenied({
  reason,
  action,
  backTo,
  backLabel,
}: {
  readonly reason?: string | undefined;
  readonly action?: string | undefined;
  readonly backTo: string;
  readonly backLabel: string;
}) {
  usePageTitle('No access');
  const viewing = action !== undefined && VIEW_ACTIONS.has(action);

  return (
    <StatePanel
      icon={<IconLock size={18} />}
      color="orange"
      title={viewing ? "You can't view this" : "You can't change this"}
      actions={[{ to: backTo, label: backLabel }]}
    >
      {reason ??
        (viewing
          ? "Your account doesn't have access to this page. Ask an admin if you need it."
          : 'Your account is read-only here. Ask an admin for more access if you need to make changes.')}
    </StatePanel>
  );
}

export function LoadError({
  error,
  what,
  onRetry,
  backTo,
  backLabel,
}: {
  readonly error: unknown;
  readonly what: string;
  readonly onRetry?: (() => void) | undefined;
  readonly backTo?: string | undefined;
  readonly backLabel?: string | undefined;
}) {
  const forbidden = isForbidden(error);

  return (
    <StatePanel
      icon={forbidden ? <IconLock size={18} /> : <IconAlertTriangle size={18} />}
      color={forbidden ? 'orange' : 'red'}
      title={forbidden ? `You can't view ${what}` : `Couldn't load ${what}`}
      actions={
        backTo !== undefined && backLabel !== undefined ? [{ to: backTo, label: backLabel }] : []
      }
      onRetry={forbidden ? undefined : onRetry}
    >
      {errorMessage(error)}
    </StatePanel>
  );
}

export function RecordLoadError({
  error,
  onRetry,
  ...record
}: RecordStateProps & { readonly error: unknown; readonly onRetry?: (() => void) | undefined }) {
  if (isNotFound(error)) {
    return <RecordNotFound {...record} />;
  }

  return (
    <LoadError
      error={error}
      what={`this ${record.resource.toLowerCase()}`}
      onRetry={onRetry}
      backTo={record.listPath}
      backLabel={`Back to ${record.listLabel.toLowerCase()}`}
    />
  );
}

export function NotFoundPage() {
  usePageTitle('Page not found');

  return (
    <Stack spacing="md" py="xl" maw={560}>
      <Title order={2}>Page not found</Title>
      <Text color="dimmed">
        There is nothing at this address. The link may be out of date, or the page may have moved.
      </Text>
      <Group spacing="xs">
        <Button component={Link} to="/jobs">
          Go to jobs
        </Button>
        <Button component={Link} to="/runs" variant="default">
          Go to runs
        </Button>
        <Button component={Link} to="/" variant="subtle">
          Dashboard
        </Button>
      </Group>
    </Stack>
  );
}
