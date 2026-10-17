import { Badge } from '@mantine/core';

import type { JobDto } from '../../lib/api';

export function JobState({ job }: { job: Pick<JobDto, 'enabled' | 'pausedReason' | 'schedule'> }) {
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
