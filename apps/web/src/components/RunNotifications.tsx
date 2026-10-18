import { Badge, Stack, Table, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';

import { type ApiClient, type RunDto, client } from '../lib/api';
import { dateTime, fromNow } from '../lib/format';

type DeliveryDto = Awaited<ReturnType<ApiClient['runs']['notifications']>>[number];

const STATE_LABEL: Record<DeliveryDto['status'], string> = {
  pending: 'Queued',
  sending: 'Sending',
  delivered: 'Delivered',
  failed: 'Gave up',
};

const EVENT_LABEL: Record<DeliveryDto['event'], string> = {
  success: 'Succeeded',
  failure: 'Attempt failed',
  permanent_failure: 'Failed',
  late: 'Late',
};

export function RunNotifications({ run }: { run: RunDto }) {
  const deliveries = useQuery({
    queryKey: ['runs', run.id, 'notifications', run.updatedAt],
    queryFn: () => client.runs.notifications({ id: run.id }),
    refetchInterval: (q) =>
      q.state.data?.some((d) => d.status === 'pending' || d.status === 'sending') ? 3_000 : false,
  });
  const rows = deliveries.data ?? [];

  return (
    <Stack className="ct-panel" p="lg" spacing="md">
      <Text weight={600}>Notifications</Text>
      {rows.length === 0 ? (
        <Text size="sm" color="dimmed">
          {deliveries.isLoading ? 'Loading…' : 'No notifications were sent for this run.'}
        </Text>
      ) : (
        <Table className="ct-table" fontSize="sm" verticalSpacing="xs">
          <thead>
            <tr>
              <th>Event</th>
              <th>Channel</th>
              <th>Delivery</th>
              <th>Attempts</th>
              <th>Last error</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id}>
                <td>{EVENT_LABEL[d.event]}</td>
                <td className="ct-mono">{d.notifier.type}</td>
                <td>
                  <Badge variant="outline" color="gray" radius="sm">
                    {STATE_LABEL[d.status]}
                  </Badge>
                  <Text size="xs" color="dimmed" title={dateTime(d.deliveredAt ?? d.updatedAt)}>
                    {fromNow(d.deliveredAt ?? d.updatedAt)}
                  </Text>
                </td>
                <td>{d.attempts}</td>
                <td>
                  <Text size="sm" color="dimmed" lineClamp={2}>
                    {d.lastError ?? '—'}
                  </Text>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Stack>
  );
}
