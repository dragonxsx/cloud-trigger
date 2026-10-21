import cronstrue from 'cronstrue';
import { z } from 'zod';

import type { JobDto } from './api';
import { chartTime } from './format';

const CronSummary = z.object({ expression: z.string(), timezone: z.string().optional() });
const IntervalSummary = z.object({ every: z.number(), unit: z.string().catch('minutes') });
const OnceSummary = z.object({ at: z.string() });
const RruleSummary = z.object({ rule: z.string(), timezone: z.string().optional() });
const HttpSummary = z.object({ url: z.string(), method: z.string().catch('POST') });

type TriggerFields = Pick<JobDto, 'trigger'> & { readonly workflowId?: string | null | undefined };

const HASH_TOKEN = /(^|[\s,/-])H(\(|\b)/;

const describeCron = (expression: string): string => {
  if (HASH_TOKEN.test(expression)) {
    return `Cron ${expression} (spread per job)`;
  }
  try {
    return cronstrue.toString(expression, { use24HourTimeFormat: true, verbose: false });
  } catch {
    return `Cron ${expression}`;
  }
};

const withZone = (text: string, zone: string | undefined): string => `${text} (${zone ?? 'UTC'})`;

const singularUnit = (unit: string): string => unit.replace(/s$/, '');

export function triggerSummary(job: TriggerFields): string {
  const { type, config } = job.trigger;
  switch (type) {
    case 'cron': {
      const cron = CronSummary.safeParse(config);

      return cron.success
        ? withZone(describeCron(cron.data.expression), cron.data.timezone)
        : 'Cron';
    }
    case 'interval': {
      const interval = IntervalSummary.safeParse(config);
      if (!interval.success) {
        return 'Interval';
      }
      const { every, unit } = interval.data;

      return every === 1 ? `Every ${singularUnit(unit)}` : `Every ${String(every)} ${unit}`;
    }
    case 'once': {
      const once = OnceSummary.safeParse(config);

      return once.success ? `Once, ${chartTime(once.data.at)}` : 'Once';
    }
    case 'rrule': {
      const rrule = RruleSummary.safeParse(config);

      return withZone('Custom recurrence', rrule.success ? rrule.data.timezone : undefined);
    }
    case 'manual':
      return job.workflowId ? 'Workflow step' : 'Manual only';
    case 'webhook':
      return 'On webhook events';
    default:
      return type.charAt(0).toUpperCase() + type.slice(1);
  }
}

export function triggerExpression(job: Pick<JobDto, 'trigger'>): string | undefined {
  const { type, config } = job.trigger;
  if (type === 'cron') {
    const cron = CronSummary.safeParse(config);

    return cron.success ? cron.data.expression : undefined;
  }
  if (type === 'once') {
    const once = OnceSummary.safeParse(config);

    return once.success ? once.data.at : undefined;
  }
  if (type === 'rrule') {
    const rrule = RruleSummary.safeParse(config);

    return rrule.success ? rrule.data.rule : undefined;
  }

  return undefined;
}

export function targetSummary(job: Pick<JobDto, 'target'>): string {
  const { connection } = job.target;
  if (connection !== undefined) {
    return connection.endpoint === undefined
      ? connection.key
      : `${connection.key} · ${connection.endpoint}`;
  }
  const http = HttpSummary.safeParse(job.target.config);

  return http.success ? `${http.data.method} ${http.data.url}` : job.target.type;
}
