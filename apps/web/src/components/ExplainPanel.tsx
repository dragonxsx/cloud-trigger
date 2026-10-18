import { Badge, Button, Collapse, Group, Stack, Table, Text } from '@mantine/core';
import { IconHelpCircle } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { type ApiClient, type JobDto, client } from '../lib/api';
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

export function ExplainPanel({ job }: { job: JobDto }) {
  const [open, setOpen] = useState(false);
  const explanation = useQuery({
    queryKey: ['jobs', job.id, 'explain', job.version, job.updatedAt],
    queryFn: () => client.jobs.explain({ id: job.id }),
    enabled: open,
  });
  const data = explanation.data;

  return (
    <Stack className="ct-panel" p="lg" spacing="sm">
      <Group position="apart">
        <Group spacing={6}>
          <IconHelpCircle size={18} />
          <Text weight={600}>Why didn&apos;t it run?</Text>
        </Group>
        <Button variant="subtle" size="xs" onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide' : 'Explain'}
        </Button>
      </Group>
      <Collapse in={open}>
        {explanation.isLoading ? (
          <Text size="sm" color="dimmed">
            Looking at recent scheduler decisions…
          </Text>
        ) : (
          data && (
            <Stack spacing="sm">
              {data.narrative.map((line) => (
                <Text key={line} size="sm">
                  {line}
                </Text>
              ))}
              {data.decisions.length > 0 && (
                <Table className="ct-table" fontSize="sm" verticalSpacing={4}>
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
              )}
            </Stack>
          )
        )}
      </Collapse>
    </Stack>
  );
}
