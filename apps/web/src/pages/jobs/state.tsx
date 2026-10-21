import { Badge, Group } from '@mantine/core';

import type { JobDto } from '../../lib/api';
import { HintBadge, LateBadge } from '../../lib/status';

type JobStateFields = Pick<
  JobDto,
  | 'enabled'
  | 'pausedReason'
  | 'schedule'
  | 'slaBreachedAt'
  | 'upstreamJobIds'
  | 'eventSource'
  | 'workflowId'
  | 'trigger'
>;

const EVENT_TRIGGERS = new Set(['webhook']);

export const DISABLED_HINT =
  'Turned off in the job settings. Enable it to schedule runs again; Resume does not apply.';

export const isHalted = (job: Pick<JobDto, 'enabled' | 'pausedReason'>): boolean =>
  !job.enabled || job.pausedReason !== null;

export function JobState({ job }: { job: JobStateFields }) {
  return (
    <Group spacing={4} noWrap>
      <ScheduleState job={job} />
      {job.slaBreachedAt !== null && <LateBadge reasons={['No recent successful run']} />}
    </Group>
  );
}

function ScheduleState({ job }: { job: JobStateFields }) {
  if (!job.enabled) {
    return <HintBadge label="Disabled" hint={DISABLED_HINT} variant="outline" color="gray" />;
  }
  if (job.pausedReason !== null) {
    return (
      <HintBadge
        label="Paused"
        hint={`${job.pausedReason}. Resume the job to schedule runs again.`}
        color="orange"
      />
    );
  }
  if (job.schedule.nextFireAt === null && job.upstreamJobIds.length > 0) {
    return <HintBadge label="Chained" hint="Runs after its upstream jobs" color="signal" />;
  }
  if (job.workflowId !== null) {
    return <HintBadge label="In workflow" hint="Runs as a step of its workflow" color="signal" />;
  }
  if (job.eventSource !== null || EVENT_TRIGGERS.has(job.trigger.type)) {
    return <HintBadge label="On events" hint="Runs when an event arrives" color="signal" />;
  }
  if (job.trigger.type === 'manual') {
    return (
      <Badge variant="outline" color="gray" tt="none">
        Manual
      </Badge>
    );
  }
  if (job.schedule.nextFireAt === null) {
    return (
      <Badge variant="outline" color="gray" tt="none">
        Finished
      </Badge>
    );
  }

  return (
    <Badge variant="light" color="signal" tt="none">
      Scheduled
    </Badge>
  );
}
