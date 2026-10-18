import { Badge, Group } from '@mantine/core';

import type { JobDto } from '../../lib/api';
import { LateBadge } from '../../lib/status';

type JobStateFields = Pick<
  JobDto,
  'enabled' | 'pausedReason' | 'schedule' | 'slaBreachedAt' | 'upstreamJobIds'
>;

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
    return (
      <Badge variant="outline" color="gray" tt="none">
        Disabled
      </Badge>
    );
  }
  if (job.pausedReason !== null) {
    return (
      <Badge variant="light" color="orange" tt="none" title={job.pausedReason}>
        Paused
      </Badge>
    );
  }
  if (job.schedule.nextFireAt === null && job.upstreamJobIds.length > 0) {
    return (
      <Badge variant="light" color="signal" tt="none" title="Runs after its upstream jobs">
        Chained
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
