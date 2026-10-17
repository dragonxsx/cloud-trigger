import { z } from 'zod';

import type { JobDto } from './api';

const CronSummary = z.object({ expression: z.string() });
const IntervalSummary = z.object({ every: z.number(), unit: z.string().catch('minutes') });
const OnceSummary = z.object({ at: z.string() });
const HttpSummary = z.object({ url: z.string(), method: z.string().catch('POST') });

export function triggerSummary(job: Pick<JobDto, 'trigger'>): string {
  const { type, config } = job.trigger;
  switch (type) {
    case 'cron': {
      const cron = CronSummary.safeParse(config);

      return cron.success ? cron.data.expression : type;
    }
    case 'interval': {
      const interval = IntervalSummary.safeParse(config);

      return interval.success ? `every ${interval.data.every} ${interval.data.unit}` : type;
    }
    case 'once': {
      const once = OnceSummary.safeParse(config);

      return once.success ? `once at ${once.data.at}` : type;
    }
    default:
      return type;
  }
}

export function targetSummary(job: Pick<JobDto, 'target'>): string {
  const http = HttpSummary.safeParse(job.target.config);

  return http.success ? `${http.data.method} ${http.data.url}` : job.target.type;
}
