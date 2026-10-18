import { Button } from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { showNotification } from '@mantine/notifications';
import { IconCalendarShare, IconPhoto } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';

import { type JobDto, client } from '../lib/api';
import { notifyError } from '../lib/errors';

export function BadgeButton({ job }: { job: JobDto }) {
  const clipboard = useClipboard();
  const url = `${window.location.origin}/badges/jobs/${job.id}.svg`;

  return (
    <Button
      variant="default"
      leftIcon={<IconPhoto size={16} />}
      onClick={() => {
        clipboard.copy(`![${job.name}](${url})`);
        showNotification({ color: 'green', message: 'Badge Markdown copied' });
      }}
    >
      Badge
    </Button>
  );
}

export function CalendarButton() {
  const clipboard = useClipboard();
  const issue = useMutation({
    mutationFn: () => client.calendar.token({}),
    onSuccess: ({ url }) => {
      clipboard.copy(url);
      showNotification({
        color: 'green',
        title: 'Calendar link copied',
        message: 'Add it to your calendar app as a subscription. It shows the next 7 days of runs.',
      });
    },
    onError: (e) => notifyError('Could not create a calendar link', e),
  });

  return (
    <Button
      variant="default"
      leftIcon={<IconCalendarShare size={16} />}
      loading={issue.isPending}
      onClick={() => issue.mutate()}
    >
      Calendar
    </Button>
  );
}
