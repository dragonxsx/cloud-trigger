import { z } from 'zod';

import { GroupId } from './ids.js';
import { type Job, NotificationRule } from './job.js';
import { type JobPolicy, JobPolicyPatch, effectivePolicy } from './policy.js';

export const RateLimit = z
  .object({
    perSecond: z
      .number()
      .positive()
      .max(10_000)
      .optional()
      .describe('Runs started per second across the group, as a token bucket (burst = rate).'),
    maxConcurrent: z
      .int()
      .min(1)
      .max(10_000)
      .optional()
      .describe('Runs executing at once across the group and all worker replicas.'),
  })
  .refine((r) => r.perSecond !== undefined || r.maxConcurrent !== undefined, {
    message: 'Set perSecond, maxConcurrent or both',
  });
export type RateLimit = z.output<typeof RateLimit>;

export const GroupSpec = z.object({
  name: z.string().trim().min(1).max(100),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour such as #6b5bd2')
    .default('#6b7280'),
  description: z.string().max(2_000).default(''),
  defaultPolicy: JobPolicyPatch.prefault({}).describe(
    'Defaults for member jobs. A job setting wins over the group setting.',
  ),
  defaultNotifications: z
    .array(NotificationRule)
    .default([])
    .describe('Sent for every member job, in addition to its own notifications.'),
  rateLimit: RateLimit.nullable().default(null),
});
export type GroupSpec = z.output<typeof GroupSpec>;
export type GroupSpecInput = z.input<typeof GroupSpec>;

export const Group = GroupSpec.extend({
  id: GroupId,
  version: z.int().min(1),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Group = z.output<typeof Group>;

export const createGroup = (p: { id: GroupId; spec: GroupSpec; now: Date }): Group => ({
  ...p.spec,
  id: p.id,
  version: 1,
  createdAt: p.now,
  updatedAt: p.now,
});

export interface ResolvedPolicy {
  readonly policy: JobPolicy;
  readonly notifications: readonly NotificationRule[];
  readonly rateLimit: RateLimit | null;
}

export const resolvePolicy = (
  job: Pick<Job, 'policy' | 'notifications'>,
  group: Pick<Group, 'defaultPolicy' | 'defaultNotifications' | 'rateLimit'> | undefined,
): ResolvedPolicy => ({
  policy: effectivePolicy(job.policy, group?.defaultPolicy),
  notifications: [...(group?.defaultNotifications ?? []), ...job.notifications],
  rateLimit: group?.rateLimit ?? null,
});
