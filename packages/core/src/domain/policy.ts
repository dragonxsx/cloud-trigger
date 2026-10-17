import { z } from 'zod';

export const RetryPolicy = z.object({
  maxAttempts: z.int().min(1).max(100).default(1),
  backoff: z.enum(['fixed', 'exponential']).default('exponential'),
  delayMs: z.int().min(0).default(1_000),
  maxDelayMs: z.int().min(0).default(300_000),
});
export type RetryPolicy = z.output<typeof RetryPolicy>;

export const OverlapPolicy = z.enum(['allow', 'forbid', 'replace', 'buffer_one']);
export type OverlapPolicy = z.output<typeof OverlapPolicy>;

export const MisfirePolicy = z.object({
  mode: z.enum(['skip', 'run_once', 'run_all']).default('run_once'),
  graceMs: z
    .int()
    .min(0)
    .default(60_000)
    .describe('A fire time older than this when the scheduler sees it is treated as missed.'),
  maxCatchup: z
    .int()
    .min(1)
    .max(1_000)
    .default(100)
    .describe('Upper bound on catch-up runs enqueued by `run_all`.'),
});
export type MisfirePolicy = z.output<typeof MisfirePolicy>;

export const SlaPolicy = z.object({
  maxDurationMs: z.int().positive().optional(),
  maxStartDelayMs: z.int().positive().optional(),
  maxSinceLastSuccessMs: z.int().positive().optional(),
});
export type SlaPolicy = z.output<typeof SlaPolicy>;

export const HistoryPolicy = z.object({
  keepSucceeded: z.int().min(0).default(100),
  keepFailed: z.int().min(0).default(500),
});
export type HistoryPolicy = z.output<typeof HistoryPolicy>;

export const JobPolicy = z.object({
  timeoutMs: z.int().min(100).max(3_600_000).default(30_000),
  retry: RetryPolicy.prefault({}),
  overlap: OverlapPolicy.default('forbid'),
  misfire: MisfirePolicy.prefault({}),
  pauseAfterConsecutiveFailures: z.int().min(1).optional(),
  sla: SlaPolicy.prefault({}),
  history: HistoryPolicy.prefault({}),
});
export type JobPolicy = z.output<typeof JobPolicy>;
export type JobPolicyInput = z.input<typeof JobPolicy>;

export function computeRetryDelay(policy: RetryPolicy, retryNumber: number): number {
  const raw =
    policy.backoff === 'fixed'
      ? policy.delayMs
      : policy.delayMs * 2 ** Math.max(0, retryNumber - 1);

  return Math.min(raw, policy.maxDelayMs);
}

export const noRetry: RetryPolicy = RetryPolicy.parse({ maxAttempts: 1 });
