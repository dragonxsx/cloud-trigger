import { defineEventTrigger } from '@cloud-trigger/core';
import { z } from 'zod';

const Outcome = z.enum(['succeeded', 'failed', 'any']);

export const AfterJobConfig = z.object({
  jobId: z
    .uuidv7()
    .meta({ title: 'Upstream job', widget: 'job', description: 'Runs when this job finishes.' }),
  on: z
    .array(Outcome)
    .min(1)
    .default(['succeeded'])
    .describe('Which upstream outcomes start a run. "failed" includes timeouts.'),
});

export const afterJobTrigger = defineEventTrigger({
  type: 'after_job',
  displayName: 'After another job',
  description: 'Runs when an upstream job finishes. The parent run is available as {{ parent }}.',
  configSchema: AfterJobConfig,
  matches: (config, event) =>
    event.kind === 'run_finished' &&
    event.jobId === config.jobId &&
    config.on.some(
      (on) =>
        on === 'any' ||
        (on === 'succeeded' && event.status === 'succeeded') ||
        (on === 'failed' && (event.status === 'failed' || event.status === 'timed_out')),
    ),
  upstream: (config) => [{ jobId: config.jobId, path: 'jobId' }],
  describe: (config) => `After job ${config.jobId.slice(-8)} ${config.on.join(' or ')}`,
});
