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
import { useMutation } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useState } from 'react';

import { type JobDto, client } from '../lib/api';
import { errorMessage, notifyError } from '../lib/errors';
import { dateTime, localTimeZone } from '../lib/format';

const LOCAL = 'YYYY-MM-DD[T]HH:mm';
const toIso = (local: string): string | undefined => {
  const parsed = dayjs(local);

  return local !== '' && parsed.isValid() ? parsed.toISOString() : undefined;
};

const DEFAULT_MAX_RUNS = 100;
const MAX_RUNS = 1_000;

export function BackfillDialog({
  job,
  opened,
  onClose,
}: {
  job: JobDto;
  opened: boolean;
  onClose: () => void;
}) {
  const [from, setFrom] = useState(() => dayjs().subtract(1, 'day').startOf('hour').format(LOCAL));
  const [to, setTo] = useState(() => dayjs().startOf('hour').format(LOCAL));
  const [maxRuns, setMaxRuns] = useState<number | undefined>(DEFAULT_MAX_RUNS);
  const invalidate = useInvalidate();
  const range = (limit: number = maxRuns ?? DEFAULT_MAX_RUNS) => {
    const fromIso = toIso(from);
    const toIsoValue = toIso(to);
    if (!fromIso || !toIsoValue) {
      throw new Error('Pick both a start and an end');
    }

    return { id: job.id, from: fromIso, to: toIsoValue, maxRuns: limit };
  };
  const preview = useMutation({
    mutationFn: (limit: number) => client.jobs.backfill({ ...range(limit), dryRun: true }),
  });
  const confirm = useMutation({
    mutationFn: () => client.jobs.backfill({ ...range(), dryRun: false }),
    onSuccess: async (result) => {
      showNotification({
        color: 'green',
        message: `${result.created.length} runs queued${result.duplicates > 0 ? `, ${result.duplicates} already backfilled` : ''}`,
      });
      onClose();
      preview.reset();
      await invalidate({ resource: 'runs', invalidates: ['list'] });
    },
    onError: (e) => notifyError('Could not backfill', e),
  });
  const reset = () => preview.reset();
  const raiseLimit = () => {
    setMaxRuns(MAX_RUNS);
    preview.mutate(MAX_RUNS);
  };
  const fireTimes = preview.data?.fireTimes ?? [];
  const firstTime = fireTimes.at(0);
  const lastTime = fireTimes.at(-1);

  return (
    <Modal opened={opened} onClose={onClose} title="Backfill past runs" size="lg">
      <Stack spacing="md">
        <Text size="sm" color="dimmed">
          Queues one run per fire time in the range. Times are in your time zone ({localTimeZone()}
          ). Runs wait for each other when the job does not allow overlap, and running it again
          never duplicates runs.
        </Text>
        <Group grow align="flex-start">
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
            description="Up to 1,000 runs"
            min={1}
            max={MAX_RUNS}
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
            {preview.data.truncated && firstTime !== undefined && lastTime !== undefined && (
              <Stack spacing="xs" mb="xs">
                <Text size="sm">
                  The limit stops at {dateTime(lastTime)}, so only {dateTime(firstTime)} to{' '}
                  {dateTime(lastTime)} is covered. Later fire times in the range are left out.
                </Text>
                {(maxRuns ?? DEFAULT_MAX_RUNS) < MAX_RUNS && (
                  <Group>
                    <Button size="xs" variant="default" onClick={raiseLimit}>
                      Raise the limit to 1,000
                    </Button>
                  </Group>
                )}
              </Stack>
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
          <Button
            variant="default"
            loading={preview.isPending}
            onClick={() => preview.mutate(maxRuns ?? DEFAULT_MAX_RUNS)}
          >
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
  );
}
