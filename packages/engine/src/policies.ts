import {
  type Clock,
  type Group,
  type GroupId,
  type GroupRepository,
  type Job,
  type JobRepository,
  type ResolvedPolicy,
  resolvePolicy,
  successDeadlineAfter,
} from '@cloud-trigger/core';

export class PolicyResolver {
  readonly #cache = new Map<GroupId, { group: Promise<Group | undefined>; until: number }>();

  constructor(
    private readonly groups: GroupRepository | undefined,
    private readonly clock: Clock,
    private readonly ttlMs = 5_000,
  ) {}

  group(id: GroupId | null): Promise<Group | undefined> {
    if (id === null || !this.groups) {
      return Promise.resolve(undefined);
    }
    const now = this.clock.now().getTime();
    const cached = this.#cache.get(id);
    if (cached && cached.until > now) {
      return cached.group;
    }
    const group = this.groups.get(id);
    this.#cache.set(id, { group, until: now + this.ttlMs });

    return group;
  }

  async resolve(job: Pick<Job, 'groupId' | 'policy' | 'notifications'>): Promise<ResolvedPolicy> {
    return resolvePolicy(job, await this.group(job.groupId));
  }
}

export const rateLimitKey = (groupId: GroupId): string => `group:${groupId}`;

export async function rearmSuccessDeadline(
  jobs: JobRepository,
  job: Pick<Job, 'id' | 'schedule'>,
  limitMs: number | undefined,
  now: Date,
): Promise<Date | null> {
  const successDeadline = successDeadlineAfter(job.schedule.lastSuccessAt ?? now, limitMs);
  await jobs.patchSchedule(job.id, { successDeadline }, { slaBreachedAt: null });

  return successDeadline;
}
