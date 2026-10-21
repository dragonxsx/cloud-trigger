import { Anchor, Group, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core';
import { useList, useShow } from '@refinedev/core';
import { DeleteButton, EditButton, Show } from '@refinedev/mantine';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { PageHeading, backIcon, countOf, pageBreadcrumb } from '../../components/page-chrome';
import { RecordLoadError } from '../../components/PageState';
import { usePageTitle } from '../../components/usePageTitle';
import type { GroupDto, JobDto } from '../../lib/api';
import { environmentLabel, useEnvironments } from '../../lib/environments';
import { duration, fromNow } from '../../lib/format';
import { JobState } from '../jobs/state';
import { rateLimitSummary } from './list';

type PolicyDto = GroupDto['defaultPolicy'];
type RuleDto = GroupDto['defaultNotifications'][number];

const OVERLAP_TEXT: Record<NonNullable<PolicyDto['overlap']>, string> = {
  forbid: 'skip the new run',
  allow: 'run in parallel',
  replace: 'cancel the running one',
  buffer_one: 'queue one, skip the rest',
};

const MISFIRE_TEXT: Record<NonNullable<NonNullable<PolicyDto['misfire']>['mode']>, string> = {
  run_once: 'run once to catch up',
  run_all: 'run every missed time',
  skip: 'skip missed times',
};

const EVENT_TEXT: Record<RuleDto['on'][number], string> = {
  success: 'Succeeded',
  failure: 'Attempt failed',
  permanent_failure: 'Failed after all attempts',
  late: 'Late',
};

const policyLines = (policy: PolicyDto): string[] => {
  const { retry, misfire, sla, history } = policy;
  const lines = [
    policy.timeoutMs === undefined ? undefined : `Time out after ${duration(policy.timeoutMs)}`,
    retry?.maxAttempts === undefined
      ? undefined
      : `Up to ${countOf(retry.maxAttempts, 'attempt')}${retry.backoff ? `, ${retry.backoff} backoff` : ''}`,
    policy.overlap === undefined
      ? undefined
      : `If the previous run is still going: ${OVERLAP_TEXT[policy.overlap]}`,
    misfire?.mode === undefined ? undefined : `After downtime: ${MISFIRE_TEXT[misfire.mode]}`,
    policy.pauseAfterConsecutiveFailures === undefined
      ? undefined
      : `Pause after ${countOf(policy.pauseAfterConsecutiveFailures, 'failure')} in a row`,
    sla?.maxStartDelayMs === undefined
      ? undefined
      : `Must start within ${duration(sla.maxStartDelayMs)}`,
    sla?.maxDurationMs === undefined
      ? undefined
      : `Must finish within ${duration(sla.maxDurationMs)}`,
    sla?.maxSinceLastSuccessMs === undefined
      ? undefined
      : `Must succeed every ${duration(sla.maxSinceLastSuccessMs)}`,
    history?.keepSucceeded === undefined
      ? undefined
      : `Keep ${countOf(history.keepSucceeded, 'succeeded run')}`,
    history?.keepFailed === undefined
      ? undefined
      : `Keep ${countOf(history.keepFailed, 'failed run')}`,
  ];

  return lines.filter((line): line is string => line !== undefined);
};

const ruleSummary = (rule: RuleDto): string =>
  `${rule.on.map((event) => EVENT_TEXT[event]).join(', ')} → ${rule.notifier.connection?.key ?? rule.notifier.type}`;

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack spacing={2}>
      <Text size="sm" color="dimmed">
        {label}
      </Text>
      {children}
    </Stack>
  );
}

function Lines({ lines, empty }: { lines: readonly string[]; empty: string }) {
  if (lines.length === 0) {
    return (
      <Text size="sm" color="dimmed">
        {empty}
      </Text>
    );
  }

  return (
    <Stack spacing={2}>
      {lines.map((line) => (
        <Text key={line} size="sm">
          {line}
        </Text>
      ))}
    </Stack>
  );
}

function EnvironmentName({ environment }: { environment: string | null }) {
  const environments = useEnvironments();
  if (environment === null) {
    return <Text size="sm">Base connection configs</Text>;
  }
  const match = environments.data?.find((e) => e.key === environment);

  return <Text size="sm">{match ? environmentLabel(match) : environment}</Text>;
}

function GroupHeading({ group }: { group: Pick<GroupDto, 'name' | 'color'> | undefined }) {
  return (
    <Group spacing="sm" noWrap>
      {group && (
        <span
          aria-hidden
          style={{
            display: 'block',
            flex: 'none',
            width: 14,
            height: 14,
            borderRadius: 4,
            background: group.color,
          }}
        />
      )}
      <PageHeading>{group?.name ?? 'Group'}</PageHeading>
    </Group>
  );
}

function GroupDetails({ group }: { group: GroupDto }) {
  const members = useList<JobDto>({
    resource: 'jobs',
    filters: [{ field: 'groupId', operator: 'eq', value: group.id }],
    pagination: { pageSize: 100 },
  });

  return (
    <Stack spacing="lg">
      {group.description && <Text>{group.description}</Text>}
      <SimpleGrid cols={3} breakpoints={[{ maxWidth: 'sm', cols: 1 }]} className="ct-panel" p="lg">
        <Fact label="Jobs">
          <Text size="sm">{members.result.total ?? 0}</Text>
        </Fact>
        <Fact label="Rate limit">
          <Text size="sm">{rateLimitSummary(group)}</Text>
        </Fact>
        <Fact label="Environment">
          <EnvironmentName environment={group.environment} />
        </Fact>
        <Fact label="Default policy">
          <Lines
            lines={policyLines(group.defaultPolicy)}
            empty="System defaults; jobs can override them."
          />
        </Fact>
        <Fact label="Default notifications">
          <Lines lines={group.defaultNotifications.map(ruleSummary)} empty="None" />
        </Fact>
      </SimpleGrid>
      <Stack className="ct-panel" p="lg" spacing="sm">
        <Title order={2} size="h4">
          Jobs in this group
        </Title>
        {members.result.data.length === 0 ? (
          <Text size="sm" color="dimmed">
            No jobs yet. Pick this group in a job&apos;s Basics section.
          </Text>
        ) : (
          <Table className="ct-table" verticalSpacing="xs" fontSize="sm">
            <thead>
              <tr>
                <th>Name</th>
                <th>State</th>
                <th>Next run</th>
              </tr>
            </thead>
            <tbody>
              {members.result.data.map((job) => (
                <tr key={job.id}>
                  <td>
                    <Anchor component={Link} to={`/jobs/show/${job.id}`} size="sm">
                      {job.name}
                    </Anchor>
                  </td>
                  <td>
                    <JobState job={job} />
                  </td>
                  <td>{fromNow(job.schedule.nextFireAt)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Stack>
    </Stack>
  );
}

function GroupHeaderButtons({ group }: { group: GroupDto | undefined }) {
  if (!group) {
    return null;
  }

  return (
    <Group spacing="xs">
      <EditButton recordItemId={group.id} />
      <DeleteButton
        recordItemId={group.id}
        confirmTitle={`Delete ${group.name}? Only a group with no jobs can be deleted.`}
        confirmOkText="Delete group"
        confirmCancelText="Cancel"
      />
    </Group>
  );
}

export function GroupShow() {
  const { query } = useShow<GroupDto>({ resource: 'groups', errorNotification: false });
  const group = query.data?.data;
  usePageTitle(group?.name, 'Groups');

  if (query.isError) {
    return (
      <RecordLoadError
        error={query.error}
        onRetry={() => void query.refetch()}
        resource="Group"
        listPath="/groups"
        listLabel="Groups"
      />
    );
  }

  return (
    <Show
      isLoading={query.isLoading}
      goBack={backIcon}
      breadcrumb={pageBreadcrumb}
      title={<GroupHeading group={group} />}
      headerButtons={<GroupHeaderButtons group={group} />}
    >
      {group && <GroupDetails group={group} />}
    </Show>
  );
}
