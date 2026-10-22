import {
  Alert,
  Badge,
  Button,
  Collapse,
  Group,
  ScrollArea,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { useId } from '@mantine/hooks';
import { IconHelpCircle } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { type ApiClient, type JobDto, orpc } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { dateTime } from '../lib/format';

type DecisionDto = Awaited<ReturnType<ApiClient['jobs']['explain']>>['decisions'][number];

const DECISION_LABEL: Record<DecisionDto['decision'], string> = {
  fired: 'Fired',
  misfire_skipped: 'Missed, skipped',
  catchup: 'Caught up',
  overlap_skipped: 'Overlap, skipped',
  paused: 'Paused',
  disabled: 'Disabled',
  rate_limited: 'Rate limited',
  finished: 'Schedule ended',
};

const SERVER_CLOCK = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC/g;

const localizeNarrative = (line: string): string =>
  line.replace(SERVER_CLOCK, (_match, day: string, time: string) => dateTime(`${day}T${time}:00Z`));

export function ExplainPanel({ job }: { job: JobDto }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const input = { id: job.id };
  const explanation = useQuery(
    orpc.jobs.explain.queryOptions({
      input,
      queryKey: [
        ...orpc.jobs.explain.queryKey({ input }),
        job.version,
        job.updatedAt,
        job.enabled,
        job.pausedReason,
      ],
      enabled: open,
    }),
  );
  const data = explanation.data;

  return (
    <Stack className="ct-panel" p="lg" spacing="sm">
      <Group position="apart" noWrap>
        <Group spacing={6} noWrap>
          <IconHelpCircle size={18} aria-hidden style={{ flexShrink: 0 }} />
          <div>
            <Title order={2} size="h5">
              Scheduler decisions
            </Title>
            <Text size="sm" color="dimmed">
              Why recent runs happened, were skipped or were held back.
            </Text>
          </div>
        </Group>
        <Button
          variant="subtle"
          size="xs"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Hide' : 'Explain'}
        </Button>
      </Group>
      <Collapse in={open} id={panelId}>
        {explanation.isLoading ? (
          <Text size="sm" color="dimmed">
            Looking at recent scheduler decisions…
          </Text>
        ) : explanation.isError ? (
          <Alert color="red" title="Couldn't load the scheduler decisions">
            <Stack spacing="xs">
              <Text size="sm">{errorMessage(explanation.error)}</Text>
              <Group>
                <Button size="xs" variant="default" onClick={() => void explanation.refetch()}>
                  Try again
                </Button>
              </Group>
            </Stack>
          </Alert>
        ) : (
          data && (
            <Stack spacing="sm">
              {data.narrative.map((line) => (
                <Text key={line} size="sm">
                  {localizeNarrative(line)}
                </Text>
              ))}
              {data.decisions.length > 0 && (
                <ScrollArea>
                  <Table className="ct-table" fontSize="sm" verticalSpacing={4} miw={560}>
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Decision</th>
                        <th>For fire time</th>
                        <th>Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.decisions.map((d) => (
                        <tr key={`${d.at}-${d.decision}-${d.runId ?? ''}`}>
                          <td>{dateTime(d.at)}</td>
                          <td>
                            <Badge variant="outline" color="gray" radius="sm" tt="none">
                              {DECISION_LABEL[d.decision]}
                            </Badge>
                          </td>
                          <td>{dateTime(d.fireTime)}</td>
                          <td>
                            <Text size="sm" color="dimmed" lineClamp={2}>
                              {d.detail}
                            </Text>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </ScrollArea>
              )}
            </Stack>
          )
        )}
      </Collapse>
    </Stack>
  );
}
