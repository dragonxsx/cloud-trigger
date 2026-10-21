import {
  ActionIcon,
  Anchor,
  Badge,
  Box,
  Button,
  Group,
  Loader,
  Pagination,
  ScrollArea,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { type CrudFilter, type CrudSort, useTable } from '@refinedev/core';
import { List } from '@refinedev/mantine';
import {
  IconArrowDown,
  IconArrowUp,
  IconArrowsSort,
  IconChevronRight,
  IconSearch,
} from '@tabler/icons-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { z } from 'zod';

import { EnvironmentSelect } from '../../components/EnvironmentSelect';
import { GroupChip } from '../../components/GroupChip';
import { JobTransferButtons } from '../../components/JobTransferButtons';
import { NextFire, useNow } from '../../components/NextFire';
import { LoadError } from '../../components/PageState';
import { CalendarButton } from '../../components/ShareButtons';
import type { GroupDto, JobDto } from '../../lib/api';
import { useEnvironments } from '../../lib/environments';
import { dateTime, fromNow } from '../../lib/format';
import { useGroupsById } from '../../lib/groups';
import { targetSummary, triggerExpression, triggerSummary } from '../../lib/job-summary';
import { JobState, isHalted } from './state';

const jobListHeader = ({ defaultButtons }: { defaultButtons: ReactNode }) => (
  <Group spacing="xs">
    <CalendarButton />
    <JobTransferButtons />
    {defaultButtons}
  </Group>
);

function MemberOf({
  groupId,
  groups,
}: {
  groupId: string | null;
  groups: ReadonlyMap<string, GroupDto>;
}) {
  const group = groupId === null ? undefined : groups.get(groupId);

  return group ? <GroupChip group={group} /> : null;
}

const FilterValue = z.string().catch('');

const filterValue = (filters: readonly CrudFilter[], field: string): string => {
  const found = filters.find((f) => 'field' in f && f.field === field);

  return FilterValue.parse(found?.value);
};

type SortKey = 'name' | 'nextRun' | 'lastSuccess' | 'failures';
type SortValue = string | number | null;

const SORT_VALUE: Record<SortKey, (job: JobDto) => SortValue> = {
  name: (job) => job.name.toLowerCase(),
  nextRun: (job) => (isHalted(job) ? null : job.schedule.nextFireAt),
  lastSuccess: (job) => job.schedule.lastSuccessAt,
  failures: (job) => job.schedule.consecutiveFailures,
};

const isSortKey = (field: string): field is SortKey => field in SORT_VALUE;

const compareValues = (a: SortValue, b: SortValue): number => {
  if (a === b) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }

  return a < b ? -1 : 1;
};

const sortJobs = (jobs: readonly JobDto[], sorter: CrudSort | undefined): readonly JobDto[] => {
  if (!sorter || !isSortKey(sorter.field)) {
    return jobs;
  }
  const value = SORT_VALUE[sorter.field];
  const direction = sorter.order === 'desc' ? -1 : 1;

  return jobs.toSorted((a, b) => {
    const left = value(a);
    const right = value(b);
    if (left === null || right === null) {
      return compareValues(left, right);
    }

    return compareValues(left, right) * direction;
  });
};

function SortHeader({
  field,
  label,
  sorter,
  onSort,
  align = 'left',
}: {
  field: SortKey;
  label: string;
  sorter: CrudSort | undefined;
  onSort: (sorters: CrudSort[]) => void;
  align?: 'left' | 'right';
}) {
  const active = sorter?.field === field ? sorter.order : undefined;
  const next = active === 'asc' ? 'desc' : 'asc';
  const icon =
    active === 'asc' ? (
      <IconArrowUp size={14} />
    ) : active === 'desc' ? (
      <IconArrowDown size={14} />
    ) : (
      <IconArrowsSort size={14} opacity={0.5} />
    );

  return (
    <th
      style={{ textAlign: align }}
      aria-label={label}
      aria-sort={active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : 'none'}
    >
      <UnstyledButton
        onClick={() => onSort([{ field, order: next }])}
        sx={{ font: 'inherit', fontWeight: 'inherit', color: 'inherit' }}
      >
        <Group spacing={4} noWrap position={align === 'right' ? 'right' : 'left'}>
          <span>{label}</span>
          {icon}
        </Group>
      </UnstyledButton>
    </th>
  );
}

const SCHEDULE_TOOLTIP_EVENTS = { hover: true, focus: true, touch: true };

function ScheduleCell({ job }: { job: JobDto }) {
  const expression = triggerExpression(job);

  return (
    <Tooltip
      label={expression}
      disabled={expression === undefined}
      withArrow
      events={SCHEDULE_TOOLTIP_EVENTS}
    >
      <Text
        size="sm"
        tabIndex={expression === undefined ? undefined : 0}
        sx={expression === undefined ? {} : { cursor: 'help' }}
      >
        {triggerSummary(job)}
        {expression !== undefined && <span className="ct-sr-only"> ({expression})</span>}
      </Text>
    </Tooltip>
  );
}

function NextRunCell({ job, now }: { job: JobDto; now: number }) {
  if (isHalted(job)) {
    return (
      <Text size="sm" color="dimmed">
        — ({job.enabled ? 'paused' : 'disabled'})
      </Text>
    );
  }

  if (job.schedule.nextFireAt === null) {
    return <Text size="sm">{fromNow(null)}</Text>;
  }

  return <NextFire at={job.schedule.nextFireAt} now={now} />;
}

function JobRow({
  job,
  groups,
  now,
}: {
  job: JobDto;
  groups: ReadonlyMap<string, GroupDto>;
  now: number;
}) {
  return (
    <tr>
      <td style={{ minWidth: 200, maxWidth: 320 }}>
        <Tooltip label={job.name} withArrow multiline width={320} openDelay={400}>
          <Anchor
            component={Link}
            to={`/jobs/show/${job.id}`}
            weight={600}
            size="sm"
            lineClamp={2}
            sx={{ overflowWrap: 'anywhere' }}
          >
            {job.name}
          </Anchor>
        </Tooltip>
        {(job.tags.length > 0 || job.groupId !== null || job.environment) && (
          <Group spacing={4} mt={2}>
            <MemberOf groupId={job.groupId} groups={groups} />
            {job.environment && (
              <Badge size="xs" variant="light" color="gray" tt="none">
                {job.environment}
              </Badge>
            )}
            {job.tags.map((t) => (
              <Badge key={t} size="xs" variant="outline" color="gray" tt="none">
                {t}
              </Badge>
            ))}
          </Group>
        )}
      </td>
      <td>
        <JobState job={job} />
      </td>
      <td style={{ minWidth: 170 }}>
        <ScheduleCell job={job} />
      </td>
      <td style={{ minWidth: 200, maxWidth: 320 }}>
        <Tooltip label={targetSummary(job)} withArrow multiline width={320} openDelay={400}>
          <Text size="sm" color="dimmed" lineClamp={2} sx={{ overflowWrap: 'anywhere' }}>
            {targetSummary(job)}
          </Text>
        </Tooltip>
      </td>
      <td>
        <NextRunCell job={job} now={now} />
      </td>
      <td>
        <Tooltip
          label={dateTime(job.schedule.lastSuccessAt)}
          disabled={job.schedule.lastSuccessAt === null}
          withArrow
        >
          <Text size="sm" color="dimmed">
            {fromNow(job.schedule.lastSuccessAt)}
          </Text>
        </Tooltip>
      </td>
      <td style={{ textAlign: 'right' }}>
        <Text size="sm" color={job.schedule.consecutiveFailures > 0 ? 'red' : 'dimmed'}>
          {job.schedule.consecutiveFailures}
        </Text>
      </td>
      <td>
        <ActionIcon
          component={Link}
          to={`/jobs/show/${job.id}`}
          size="lg"
          variant="subtle"
          aria-label={`Open ${job.name}`}
        >
          <IconChevronRight size={18} />
        </ActionIcon>
      </td>
    </tr>
  );
}

function EmptyJobs({ filtered, onClear }: { filtered: boolean; onClear: () => void }) {
  if (filtered) {
    return (
      <Stack align="center" spacing="xs" p="lg">
        <Text color="dimmed" align="center">
          No jobs match these filters.
        </Text>
        <Button variant="default" size="xs" onClick={onClear}>
          Clear filters
        </Button>
      </Stack>
    );
  }

  return (
    <Text color="dimmed" p="lg" align="center">
      No jobs yet. Create one to start calling an endpoint on a schedule.
    </Text>
  );
}

export function JobList() {
  const {
    tableQuery,
    currentPage,
    setCurrentPage,
    pageCount,
    filters,
    setFilters,
    sorters,
    setSorters,
  } = useTable<JobDto>({
    resource: 'jobs',
    pagination: { pageSize: 20 },
    sorters: { mode: 'off' },
    syncWithLocation: true,
  });
  const [search, setSearch] = useState(() => filterValue(filters, 'search'));
  const [debounced] = useDebouncedValue(search, 250);
  const [environment, setEnvironment] = useState<string | null>(
    () => filterValue(filters, 'environment') || null,
  );
  useEffect(() => {
    setFilters(
      [
        { field: 'search', operator: 'contains', value: debounced || undefined },
        { field: 'environment', operator: 'eq', value: environment ?? undefined },
      ],
      'replace',
    );
  }, [debounced, environment, setFilters]);
  const sorter = sorters[0];
  const items = useMemo(
    () => sortJobs(tableQuery.data?.data ?? [], sorter),
    [tableQuery.data?.data, sorter],
  );
  const groups = useGroupsById();
  const environments = useEnvironments();
  const now = useNow();
  const filtered = debounced !== '' || environment !== null;
  const changeSearch = (value: string) => {
    setSearch(value);
    setCurrentPage(1);
  };
  const changeEnvironment = (value: string | null) => {
    setEnvironment(value);
    setCurrentPage(1);
  };
  const clearFilters = () => {
    changeSearch('');
    changeEnvironment(null);
  };

  return (
    <List
      title={
        <Title order={1} size="h3">
          Jobs
        </Title>
      }
      headerButtons={jobListHeader}
    >
      <Stack spacing="md">
        <Stack spacing={4}>
          <Group spacing="sm" align="flex-end">
            <TextInput
              label="Search"
              placeholder="Search by name"
              icon={<IconSearch size={16} />}
              value={search}
              onChange={(e) => changeSearch(e.currentTarget.value)}
              w={360}
              maw="100%"
            />
            {(environments.data?.length ?? 0) > 0 && (
              <EnvironmentSelect
                label="Environment"
                placeholder="Any environment"
                value={environment}
                onChange={changeEnvironment}
              />
            )}
            {tableQuery.isFetching && !tableQuery.isLoading && (
              <Loader size="xs" mb={10} aria-label="Updating jobs" />
            )}
          </Group>
          {environment !== null && (
            <Text size="xs" color="dimmed">
              Shows jobs that set this environment themselves. Jobs that inherit it from their group
              are not included.
            </Text>
          )}
        </Stack>
        {tableQuery.isError ? (
          <LoadError
            error={tableQuery.error}
            what="jobs"
            onRetry={() => void tableQuery.refetch()}
          />
        ) : items.length === 0 && !tableQuery.isLoading ? (
          <EmptyJobs filtered={filtered} onClear={clearFilters} />
        ) : (
          <Box
            sx={{
              opacity: tableQuery.isFetching && !tableQuery.isLoading ? 0.6 : 1,
              transition: 'opacity 150ms',
            }}
            aria-busy={tableQuery.isFetching}
          >
            <ScrollArea>
              <Table highlightOnHover verticalSpacing="xs" className="ct-table" miw={980}>
                <thead>
                  <tr>
                    <SortHeader field="name" label="Name" sorter={sorter} onSort={setSorters} />
                    <th>State</th>
                    <th>Schedule</th>
                    <th>Target</th>
                    <SortHeader
                      field="nextRun"
                      label="Next run"
                      sorter={sorter}
                      onSort={setSorters}
                    />
                    <SortHeader
                      field="lastSuccess"
                      label="Last success"
                      sorter={sorter}
                      onSort={setSorters}
                    />
                    <SortHeader
                      field="failures"
                      label="Failures in a row"
                      sorter={sorter}
                      onSort={setSorters}
                      align="right"
                    />
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((job) => (
                    <JobRow key={job.id} job={job} groups={groups} now={now} />
                  ))}
                </tbody>
              </Table>
            </ScrollArea>
          </Box>
        )}
        {pageCount > 1 && (
          <Group position="apart">
            <Text size="xs" color="dimmed">
              {sorter ? 'Sorting applies to the jobs on this page.' : ''}
            </Text>
            <Pagination page={currentPage} total={pageCount} onChange={setCurrentPage} />
          </Group>
        )}
      </Stack>
    </List>
  );
}
