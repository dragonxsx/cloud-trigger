import { z } from 'zod';

import { JobId, RunId } from './ids.js';

export const DecisionKind = z.enum([
  'fired',
  'misfire_skipped',
  'catchup',
  'overlap_skipped',
  'paused',
  'disabled',
  'rate_limited',
  'finished',
]);
export type DecisionKind = z.output<typeof DecisionKind>;

export const ScheduleDecision = z.object({
  jobId: JobId,
  runId: RunId.nullable().default(null),
  at: z.date().describe('When the scheduler or worker made the decision.'),
  fireTime: z.date().nullable().describe('The scheduled time the decision is about, if any.'),
  decision: DecisionKind,
  detail: z.string(),
});
export type ScheduleDecision = z.output<typeof ScheduleDecision>;
export type ScheduleDecisionInput = z.input<typeof ScheduleDecision>;
