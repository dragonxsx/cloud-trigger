import {
  Alert,
  Button,
  Group,
  List,
  Modal,
  NumberInput,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { useInvalidate } from '@refinedev/core';
import { IconHistory } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useState } from 'react';

import { type JobDto, client } from '../lib/api';
import { errorMessage, notifyError } from '../lib/errors';
import { dateTime } from '../lib/format';

const LOCAL = 'YYYY-MM-DD[T]HH:mm';
const toIso = (local: string): string | undefined => {
  const parsed = dayjs(local);

  return local !== '' && parsed.isValid() ? parsed.toISOString() : undefined;
};

export function BackfillDialog({ job }: { job: JobDto }) {
  const [opened, setOpened] = useState(false);
  const [from, setFrom] = useState(() => dayjs().subtract(1, 'day').startOf('hour').format(LOCAL));
  const [to, setTo] = useState(() => dayjs().startOf('hour').format(LOCAL));
  const [maxRuns, setMaxRuns] = useState<number | undefined>(100);
  const invalidate = useInvalidate();
  const range = () => {
    const fromIso = toIso(from);
    const toIsoValue = toIso(to);
    if (!fromIso || !toIsoValue) {
      throw new Error('Pick both a start and an end');
    }

    return { id: job.id, from: fromIso, to: toIsoValue, maxRuns: maxRuns ?? 100 };
  };
  const preview = useMutation({
    mutationFn: () => client.jobs.backfill({ ...range(), dryRun: true }),
  });
  const confirm = useMutation({
    mutationFn: () => client.jobs.backfill({ ...range(), dryRun: false }),
    onSuccess: async (result) => {
      showNotification({
        color: 'green',
        message: `${result.created.length} runs queued${result.duplicates > 0 ? `, ${result.duplicates} already backfilled` : ''}`,
      });
      setOpened(false);
      preview.reset();
      await invalidate({ resource: 'runs', invalidates: ['list'] });
    },
    onError: (e) => notifyError('Could not backfill', e),
  });
  const reset = () => preview.reset();

  return (
    <>
      <Button
        variant="default"
        leftIcon={<IconHistory size={16} />}
        onClick={() => setOpened(true)}
      >
        Backfill
      </Button>
      <Modal opened={opened} onClose={() => setOpened(false)} title="Backfill past runs" size="lg">
        <Stack spacing="md">
          <Text size="sm" color="dimmed">
            Queues one run per fire time in the range (your local time). Runs wait for each other
            when the job does not allow overlap, and running it again never duplicates runs.
          </Text>
          <Group grow>
            <TextInput
              type="datetime-local"
              label="From"
              value={from}
              onChange={(e) => {
                setFrom(e.currentTarget.value);
                reset();
              }}
            />
            <TextInput
              type="datetime-local"
              label="To"
              value={to}
              onChange={(e) => {
                setTo(e.currentTarget.value);
                reset();
              }}
            />
            <NumberInput
              label="At most"
              min={1}
              max={1_000}
              value={maxRuns}
              onChange={(v) => {
                setMaxRuns(v);
                reset();
              }}
            />
          </Group>
          {preview.isError && <Alert color="red">{errorMessage(preview.error)}</Alert>}
          {preview.data && (
            <Alert color="gray" title={`${preview.data.fireTimes.length} runs would be queued`}>
              {preview.data.truncated && (
                <Text size="sm" mb="xs">
                  More fire times exist in this range; raise the limit or narrow the range.
                </Text>
              )}
              <List size="sm" spacing={2}>
                {preview.data.fireTimes.slice(0, 5).map((t) => (
                  <List.Item key={t}>{dateTime(t)}</List.Item>
                ))}
                {preview.data.fireTimes.length > 5 && (
                  <List.Item>…and {preview.data.fireTimes.length - 5} more</List.Item>
                )}
              </List>
            </Alert>
          )}
          <Group position="right">
            <Button variant="default" loading={preview.isPending} onClick={() => preview.mutate()}>
              Preview
            </Button>
            <Button
              disabled={!preview.data || preview.data.fireTimes.length === 0}
              loading={confirm.isPending}
              onClick={() => confirm.mutate()}
            >
              Queue {preview.data?.fireTimes.length ?? ''} runs
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
