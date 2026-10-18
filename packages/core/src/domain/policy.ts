import { defu } from 'defu';
import { z } from 'zod';

const retryFields = {
  maxAttempts: z.int().min(1).max(100),
  backoff: z.enum(['fixed', 'exponential']),
  delayMs: z.int().min(0),
  maxDelayMs: z.int().min(0),
};

export const RetryPolicy = z.object({
  maxAttempts: retryFields.maxAttempts.default(1),
  backoff: retryFields.backoff.default('exponential'),
  delayMs: retryFields.delayMs.default(1_000),
  maxDelayMs: retryFields.maxDelayMs.default(300_000),
});
export type RetryPolicy = z.output<typeof RetryPolicy>;

export const OverlapPolicy = z.enum(['allow', 'forbid', 'replace', 'buffer_one']);
export type OverlapPolicy = z.output<typeof OverlapPolicy>;

const misfireFields = {
  mode: z.enum(['skip', 'run_once', 'run_all']),
  graceMs: z
    .int()
    .min(0)
    .describe('A fire time older than this when the scheduler sees it is treated as missed.'),
  maxCatchup: z
    .int()
    .min(1)
    .max(1_000)
    .describe('Upper bound on catch-up runs enqueued by `run_all`.'),
};

export const MisfirePolicy = z.object({
  mode: misfireFields.mode.default('run_once'),
  graceMs: misfireFields.graceMs.default(60_000),
  maxCatchup: misfireFields.maxCatchup.default(100),
});
export type MisfirePolicy = z.output<typeof MisfirePolicy>;

export const SlaPolicy = z.object({
  maxDurationMs: z.int().positive().optional(),
  maxStartDelayMs: z.int().positive().optional(),
  maxSinceLastSuccessMs: z.int().positive().optional(),
});
export type SlaPolicy = z.output<typeof SlaPolicy>;

const historyFields = { keepSucceeded: z.int().min(0), keepFailed: z.int().min(0) };

export const HistoryPolicy = z.object({
  keepSucceeded: historyFields.keepSucceeded.default(100),
  keepFailed: historyFields.keepFailed.default(500),
});
export type HistoryPolicy = z.output<typeof HistoryPolicy>;

const timeoutMs = z.int().min(100).max(3_600_000);
const pauseAfterConsecutiveFailures = z.int().min(1);

export const JobPolicy = z.object({
  timeoutMs: timeoutMs.default(30_000),
  retry: RetryPolicy.prefault({}),
  overlap: OverlapPolicy.default('forbid'),
  misfire: MisfirePolicy.prefault({}),
  pauseAfterConsecutiveFailures: pauseAfterConsecutiveFailures.optional(),
  sla: SlaPolicy.prefault({}),
  history: HistoryPolicy.prefault({}),
});
export type JobPolicy = z.output<typeof JobPolicy>;
export type JobPolicyInput = z.input<typeof JobPolicy>;

export const JobPolicyPatch = z
  .object({
    timeoutMs: timeoutMs.optional(),
    retry: z.object(retryFields).partial().optional(),
    overlap: OverlapPolicy.optional(),
    misfire: z.object(misfireFields).partial().optional(),
    pauseAfterConsecutiveFailures: pauseAfterConsecutiveFailures.optional(),
    sla: SlaPolicy.optional(),
    history: z.object(historyFields).partial().optional(),
  })
  .describe('Overrides only. Unset fields inherit from the group, then from system defaults.');
export type JobPolicyPatch = z.output<typeof JobPolicyPatch>;

export const effectivePolicy = (...layers: readonly (JobPolicyPatch | undefined)[]): JobPolicy =>
  JobPolicy.parse(defu({}, ...layers.filter((layer) => layer !== undefined)));

export function computeRetryDelay(policy: RetryPolicy, retryNumber: number): number {
  const raw =
    policy.backoff === 'fixed'
      ? policy.delayMs
      : policy.delayMs * 2 ** Math.max(0, retryNumber - 1);

  return Math.min(raw, policy.maxDelayMs);
}

export const noRetry: RetryPolicy = RetryPolicy.parse({ maxAttempts: 1 });
