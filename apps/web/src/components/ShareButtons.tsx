import { ActionIcon, Button, CopyButton, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { openModal } from '@mantine/modals';
import { showNotification } from '@mantine/notifications';
import { IconCalendarShare, IconCheck, IconCopy } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { client } from '../lib/api';
import { notifyError } from '../lib/errors';

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);

    return true;
  } catch {
    return false;
  }
}

function CopyFallback({ value, note }: { value: string; note: ReactNode }) {
  return (
    <Stack spacing="sm">
      <Text size="sm">Your browser blocked the clipboard. Copy the text below instead.</Text>
      <TextInput
        readOnly
        aria-label="Text to copy"
        value={value}
        onFocus={(e) => e.currentTarget.select()}
        data-autofocus
        rightSection={
          <CopyButton value={value}>
            {(clipboard) => (
              <>
                <Tooltip label={clipboard.copied ? 'Copied' : 'Copy'} withArrow>
                  <ActionIcon
                    onClick={() => clipboard.copy()}
                    aria-label={clipboard.copied ? 'Copied' : 'Copy'}
                    color={clipboard.copied ? 'teal' : 'gray'}
                  >
                    {clipboard.copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                  </ActionIcon>
                </Tooltip>
                <output className="ct-sr-only">{clipboard.copied ? 'Copied' : ''}</output>
              </>
            )}
          </CopyButton>
        }
      />
      <Text size="xs" color="dimmed">
        {note}
      </Text>
    </Stack>
  );
}

export async function copyWithFallback({
  value,
  copiedTitle,
  fallbackTitle,
  note,
}: {
  value: string;
  copiedTitle: string;
  fallbackTitle: string;
  note: ReactNode;
}): Promise<void> {
  if (await copyToClipboard(value)) {
    showNotification({ color: 'teal', title: copiedTitle, message: note });

    return;
  }
  openModal({
    title: fallbackTitle,
    centered: true,
    children: <CopyFallback value={value} note={note} />,
  });
}

export function CalendarButton() {
  const issue = useMutation({
    mutationFn: () => client.calendar.token({}),
    onSuccess: ({ url }) =>
      copyWithFallback({
        value: url,
        copiedTitle: 'Calendar link copied',
        fallbackTitle: 'Calendar subscription link',
        note: 'Add it to your calendar app as a subscription. It shows the next 7 days of runs.',
      }),
    onError: (e) => notifyError("Couldn't create a calendar link", e),
  });

  return (
    <Button
      variant="default"
      leftIcon={<IconCalendarShare size={16} />}
      loading={issue.isPending}
      onClick={() => issue.mutate()}
    >
      Subscribe in calendar
    </Button>
  );
}
