import { RunReason, RunStatus } from '@cloud-trigger/core';
import { Chip, Group, Pagination, Select, Stack } from '@mantine/core';
import { useTable } from '@refinedev/core';
import { List } from '@refinedev/mantine';
import { useEffect, useState } from 'react';

import { RunsTable } from '../../components/RunsTable';
import type { RunDto } from '../../lib/api';
import { STATUS } from '../../lib/status';

const STATUSES = RunStatus.options;
const REASONS = RunReason.options;

export function RunList() {
  const [statuses, setStatuses] = useState<string[]>([]);
  const [reason, setReason] = useState<string | null>(null);
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
      ],
      'replace',
    );
  }, [statuses, reason, setFilters]);

  return (
    <List title="Runs" canCreate={false}>
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
    </List>
  );
}
