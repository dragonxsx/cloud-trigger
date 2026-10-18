import {
  type Clock,
  type ConfigError,
  type ConflictError,
  type Group,
  type GroupId,
  type GroupQuery,
  type GroupRepository,
  GroupSpec,
  type Job,
  type JobRepository,
  type NotFoundError,
  type Page,
  type ProviderRegistry,
  type Result,
  type VersionConflictError,
  configErrorFromZod,
  createGroup,
  err,
  newGroupId,
  ok,
  resolvePolicy,
} from '@cloud-trigger/core';

import { rearmSuccessDeadline } from './policies.js';

export interface GroupServiceDeps {
  readonly groups: GroupRepository;
  readonly jobs: JobRepository;
  readonly registry: ProviderRegistry;
  readonly clock: Clock;
}

const sinceSuccessLimit = (job: Job, group: Group) =>
  resolvePolicy(job, group).policy.sla.maxSinceLastSuccessMs;

export class GroupService {
  constructor(private readonly deps: GroupServiceDeps) {}

  validate(raw: unknown): Result<GroupSpec, ConfigError> {
    const parsed = GroupSpec.safeParse(raw);
    if (!parsed.success) {
      return err(configErrorFromZod(parsed.error));
    }
    const issues = parsed.data.defaultNotifications.flatMap((rule, i) => {
      const path = `defaultNotifications.${i}.notifier`;
      const bound = this.deps.registry
        .get('notifier', rule.notifier.type)
        .andThen((provider) => provider.bind(rule.notifier.config));
      if (bound.isOk()) {
        return [];
      }

      return bound.error.code === 'unknown_provider'
        ? [{ path: `${path}.type`, message: bound.error.message }]
        : bound.error.issues.map((issue) => ({
            path: `${path}.config${issue.path ? `.${issue.path}` : ''}`,
            message: issue.message,
          }));
    });

    return issues.length === 0
      ? ok(parsed.data)
      : err({ code: 'invalid_config', message: 'Invalid group configuration', issues });
  }

  async create(raw: unknown): Promise<Result<Group, ConfigError | ConflictError>> {
    const spec = this.validate(raw);
    if (spec.isErr()) {
      return err(spec.error);
    }

    return this.deps.groups.insert(
      createGroup({ id: newGroupId(), spec: spec.value, now: this.deps.clock.now() }),
    );
  }

  async update(
    id: GroupId,
    raw: unknown,
    expectedVersion: number,
  ): Promise<Result<Group, ConfigError | ConflictError | NotFoundError | VersionConflictError>> {
    const spec = this.validate(raw);
    if (spec.isErr()) {
      return err(spec.error);
    }

    const before = await this.deps.groups.get(id);
    const updated = await this.deps.groups.update(
      id,
      { spec: spec.value, updatedAt: this.deps.clock.now() },
      expectedVersion,
    );
    if (updated.isOk() && before) {
      await this.#rearmMemberSlas(before, updated.value);
    }

    return updated;
  }

  async #rearmMemberSlas(before: Group, after: Group): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await this.deps.jobs.list({ groupId: after.id, limit: 200, cursor });
      for (const job of page.items) {
        const limit = sinceSuccessLimit(job, after);
        if (limit !== sinceSuccessLimit(job, before)) {
          await rearmSuccessDeadline(this.deps.jobs, job, limit, this.deps.clock.now());
        }
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
  }

  get(id: GroupId): Promise<Group | undefined> {
    return this.deps.groups.get(id);
  }

  list(query: GroupQuery): Promise<Page<Group>> {
    return this.deps.groups.list(query);
  }

  async delete(id: GroupId): Promise<Result<void, NotFoundError | ConflictError>> {
    const members = await this.deps.jobs.list({ groupId: id, limit: 1 });
    if (members.total > 0) {
      return err({
        code: 'conflict',
        message: `Group still has ${members.total} job(s); move or delete them first`,
      });
    }

    return (await this.deps.groups.delete(id))
      ? ok(undefined)
      : err({ code: 'not_found', message: `Group ${id} not found` });
  }
}
