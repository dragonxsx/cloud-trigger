import { RunReason, RunStatus } from '@cloud-trigger/core';
import { Chip, Group, Pagination, Select, Stack, Tabs } from '@mantine/core';
import { useTable } from '@refinedev/core';
import { List } from '@refinedev/mantine';
import { useEffect, useState } from 'react';

import { RunsTable } from '../../components/RunsTable';
import type { RunDto } from '../../lib/api';
import { STATUS } from '../../lib/status';
import { FailedRuns } from './failed';

const STATUSES = RunStatus.options;
const REASONS = RunReason.options;

export function RunList() {
  const [tab, setTab] = useState<string | null>('all');

  return (
    <List title="Runs" canCreate={false}>
      <Tabs value={tab} onTabChange={setTab} keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="all">All runs</Tabs.Tab>
          <Tabs.Tab value="failed">Failed</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="all">
          <AllRuns />
        </Tabs.Panel>
        <Tabs.Panel value="failed">
          <FailedRuns />
        </Tabs.Panel>
      </Tabs>
    </List>
  );
}

function AllRuns() {
  const [statuses, setStatuses] = useState<string[]>([]);
  const [reason, setReason] = useState<string | null>(null);
  const [lateOnly, setLateOnly] = useState(false);
  const { tableQuery, currentPage, setCurrentPage, pageCount, setFilters } = useTable<RunDto>({
    resource: 'runs',
    pagination: { pageSize: 50 },
    liveMode: 'auto',
  });
  useEffect(() => {
    setFilters(
      [
        { field: 'status', operator: 'in', value: statuses.length > 0 ? statuses : undefined },
        { field: 'reason', operator: 'eq', value: reason ?? undefined },
        { field: 'late', operator: 'eq', value: lateOnly ? true : undefined },
      ],
      'replace',
    );
  }, [statuses, reason, lateOnly, setFilters]);

  return (
    <Stack spacing="md">
      <Group position="apart" align="flex-end">
        <Chip.Group multiple value={statuses} onChange={setStatuses}>
          <Group spacing={6}>
            {STATUSES.map((s) => (
              <Chip key={s} value={s} size="sm">
                {STATUS[s].label}
              </Chip>
            ))}
          </Group>
        </Chip.Group>
        <Group spacing="sm">
          <Chip checked={lateOnly} onChange={setLateOnly} size="sm" variant="filled">
            Late only
          </Chip>
          <Select
            placeholder="Any reason"
            data={REASONS}
            value={reason}
            onChange={setReason}
            clearable
            w={180}
            aria-label="Reason"
          />
        </Group>
      </Group>
      <RunsTable runs={tableQuery.data?.data ?? []} />
      {pageCount > 1 && (
        <Pagination
          page={currentPage}
          total={pageCount}
          onChange={setCurrentPage}
          position="right"
        />
      )}
    </Stack>
  );
}
