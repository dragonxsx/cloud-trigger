import { RunReason, RunStatus } from '@cloud-trigger/core';
import {
  Badge,
  Box,
  Button,
  Chip,
  CloseButton,
  Group,
  Pagination,
  Select,
  Stack,
  Tabs,
  Text,
} from '@mantine/core';
import { type CrudFilter, useList, useOne, useTable } from '@refinedev/core';
import { List } from '@refinedev/mantine';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { z } from 'zod';

import { PageHeading } from '../../components/page-chrome';
import { LoadError } from '../../components/PageState';
import { REASON_LABEL, RunsTable } from '../../components/RunsTable';
import type { JobDto, RunDto } from '../../lib/api';
import { STATUS } from '../../lib/status';
import { FAILED_INBOX, FailedRuns } from './failed';

const STATUSES = RunStatus.options;
const REASON_OPTIONS = RunReason.options.map((value) => ({ value, label: REASON_LABEL[value] }));
const VIEW_PARAM = 'view';

const valueOf = (filters: readonly CrudFilter[], field: string): unknown =>
  filters.find((f) => 'field' in f && f.field === field)?.value;

const StatusList = z.array(RunStatus).catch([]);
const ReasonValue = RunReason.nullable().catch(null);
const LateValue = z
  .union([z.boolean(), z.enum(['true', 'false']).transform((value) => value === 'true')])
  .catch(false);
const JobIdValue = z.string().min(1).nullable().catch(null);

const hasUrlFilters = (params: URLSearchParams): boolean =>
  [...params.keys()].some((key) => key.startsWith('filters'));

export function RunList() {
  const [params, setParams] = useSearchParams();
  const tab = params.get(VIEW_PARAM) === 'failed' ? 'failed' : 'all';
  const inbox = useList<RunDto>({
    resource: 'runs',
    filters: [...FAILED_INBOX],
    pagination: { currentPage: 1, pageSize: 1 },
    liveMode: 'auto',
  });
  const failedCount = inbox.result.total;

  return (
    <List title={<PageHeading>Runs</PageHeading>} canCreate={false} breadcrumb={false}>
      <Tabs
        value={tab}
        onTabChange={(next) => setParams(next === 'failed' ? { [VIEW_PARAM]: 'failed' } : {})}
        keepMounted={false}
      >
        <Tabs.List mb="md">
          <Tabs.Tab value="all">All runs</Tabs.Tab>
          <Tabs.Tab
            value="failed"
            rightSection={
              failedCount !== undefined && failedCount > 0 ? (
                <Badge size="sm" color="red" variant="filled" radius="xl">
                  {failedCount.toLocaleString()}
                  <span className="ct-sr-only"> to triage</span>
                </Badge>
              ) : undefined
            }
          >
            Failed
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="all">
          <AllRuns key={hasUrlFilters(params) ? 'filtered' : 'reset'} />
        </Tabs.Panel>
        <Tabs.Panel value="failed">
          <FailedRuns />
        </Tabs.Panel>
      </Tabs>
    </List>
  );
}

function JobFilterChip({ jobId, onClear }: { jobId: string; onClear: () => void }) {
  const job = useOne<JobDto>({ resource: 'jobs', id: jobId });
  const name = job.result?.name ?? (job.query.isError ? jobId : 'Loading…');

  return (
    <Badge
      size="lg"
      radius="sm"
      variant="outline"
      color="gray"
      styles={{ root: { textTransform: 'none', fontWeight: 500 } }}
      rightSection={
        <CloseButton size="xs" aria-label={`Stop filtering by job ${name}`} onClick={onClear} />
      }
    >
      Job: {name}
    </Badge>
  );
}

function AllRuns() {
  const { tableQuery, currentPage, setCurrentPage, pageCount, setFilters, filters } =
    useTable<RunDto>({
      resource: 'runs',
      pagination: { pageSize: 50 },
      liveMode: 'auto',
    });
  const [statuses, setStatuses] = useState<string[]>(() =>
    StatusList.parse(valueOf(filters, 'status')),
  );
  const [reason, setReason] = useState<string | null>(() =>
    ReasonValue.parse(valueOf(filters, 'reason') ?? null),
  );
  const [lateOnly, setLateOnly] = useState(() => LateValue.parse(valueOf(filters, 'late')));
  const [jobId, setJobId] = useState<string | null>(() =>
    JobIdValue.parse(valueOf(filters, 'jobId') ?? null),
  );
  useEffect(() => {
    setFilters(
      [
        { field: 'status', operator: 'in', value: statuses.length > 0 ? statuses : undefined },
        { field: 'reason', operator: 'eq', value: reason ?? undefined },
        { field: 'late', operator: 'eq', value: lateOnly ? true : undefined },
        { field: 'jobId', operator: 'eq', value: jobId ?? undefined },
      ],
      'replace',
    );
  }, [statuses, reason, lateOnly, jobId, setFilters]);

  const filtered = statuses.length > 0 || reason !== null || lateOnly || jobId !== null;
  const clearFilters = () => {
    setStatuses([]);
    setReason(null);
    setLateOnly(false);
    setJobId(null);
  };

  return (
    <Stack spacing="md">
      <Group position="apart" align="flex-end" spacing="sm">
        <Box
          component="fieldset"
          sx={{ flex: '1 1 320px', minWidth: 0, border: 0, margin: 0, padding: 0 }}
        >
          <legend className="ct-sr-only">Filter by status</legend>
          <Chip.Group multiple value={statuses} onChange={setStatuses}>
            <Group spacing={6} sx={{ flexWrap: 'wrap' }}>
              {STATUSES.map((s) => (
                <Chip key={s} value={s} size="sm">
                  {STATUS[s].label}
                </Chip>
              ))}
            </Group>
          </Chip.Group>
        </Box>
        <Group spacing="sm" sx={{ flexWrap: 'wrap' }}>
          {jobId !== null && <JobFilterChip jobId={jobId} onClear={() => setJobId(null)} />}
          <Chip checked={lateOnly} onChange={setLateOnly} size="sm">
            Late only
          </Chip>
          <Select
            placeholder="Any reason"
            data={REASON_OPTIONS}
            value={reason}
            onChange={setReason}
            clearable
            w={180}
            aria-label="Reason"
          />
        </Group>
      </Group>
      {tableQuery.isError ? (
        <LoadError
          error={tableQuery.error}
          what="runs"
          onRetry={() => {
            void tableQuery.refetch();
          }}
        />
      ) : (
        <RunsTable
          runs={tableQuery.data?.data ?? []}
          loading={tableQuery.isLoading}
          empty={
            filtered ? (
              <Stack spacing="xs" align="center">
                <Text color="dimmed">No runs match these filters.</Text>
                <Button variant="default" size="xs" onClick={clearFilters}>
                  Clear filters
                </Button>
              </Stack>
            ) : undefined
          }
        />
      )}
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
