import { isDeepStrictEqual } from 'node:util';

import {
  type Clock,
  type ConfigError,
  type ConflictError,
  type ConfigIssue,
  type ConnectionRepository,
  type EnvironmentRepository,
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
  notificationConnectionRefs,
  ok,
  resolvePolicy,
} from '@cloud-trigger/core';

import {
  bindJob,
  bindNotifications,
  inheritedNotificationIssues,
  loadConnections,
  unknownEnvironment,
} from './config-validation.js';
import { rearmSuccessDeadline } from './policies.js';

export interface GroupServiceDeps {
  readonly groups: GroupRepository;
  readonly jobs: JobRepository;
  readonly connections: ConnectionRepository;
  readonly environments: EnvironmentRepository;
  readonly registry: ProviderRegistry;
  readonly clock: Clock;
}

const sinceSuccessLimit = (job: Job, group: Group) =>
  resolvePolicy(job, group).policy.sla.maxSinceLastSuccessMs;

const invalidGroup = (issues: readonly ConfigIssue[]): ConfigError => ({
  code: 'invalid_config',
  message: 'Invalid group configuration',
  issues,
});

export class GroupService {
  constructor(private readonly deps: GroupServiceDeps) {}

  async validate(raw: unknown): Promise<Result<GroupSpec, ConfigError>> {
    const parsed = GroupSpec.safeParse(raw);
    if (!parsed.success) {
      return err(configErrorFromZod(parsed.error));
    }
    const { defaultNotifications: rules, environment } = parsed.data;
    const unknown = await unknownEnvironment(this.deps.environments, environment);
    if (unknown.length > 0) {
      return err(invalidGroup(unknown));
    }
    const catalog = await loadConnections(
      this.deps.connections,
      notificationConnectionRefs(rules),
      environment,
    );
    const bound = bindNotifications(this.deps.registry, rules, catalog, 'defaultNotifications');

    return bound.isOk() ? ok(parsed.data) : err(invalidGroup(bound.error.issues));
  }

  async create(raw: unknown): Promise<Result<Group, ConfigError | ConflictError>> {
    const spec = await this.validate(raw);
    if (spec.isErr()) {
      return err(spec.error);
    }

    return this.deps.groups.insert(
      createGroup({
        id: newGroupId(),
        spec: spec.value,
        connectionRefs: notificationConnectionRefs(spec.value.defaultNotifications),
        now: this.deps.clock.now(),
      }),
    );
  }

  async update(
    id: GroupId,
    raw: unknown,
    expectedVersion: number,
  ): Promise<Result<Group, ConfigError | ConflictError | NotFoundError | VersionConflictError>> {
    const spec = await this.validate(raw);
    if (spec.isErr()) {
      return err(spec.error);
    }

    const before = await this.deps.groups.get(id);
    if (before) {
      const broken = await this.#brokenMembers(before, spec.value);
      if (broken.length > 0) {
        return err(invalidGroup(broken));
      }
    }
    const updated = await this.deps.groups.update(
      id,
      {
        spec: spec.value,
        connectionRefs: notificationConnectionRefs(spec.value.defaultNotifications),
        updatedAt: this.deps.clock.now(),
      },
      expectedVersion,
    );
    if (updated.isOk() && before) {
      await this.#rearmMemberSlas(before, updated.value);
    }

    return updated;
  }

  /** Members whose inherited environment or default notifications would stop binding after the update. */
  async #brokenMembers(before: Group, after: GroupSpec): Promise<ConfigIssue[]> {
    const environmentChanged = before.environment !== after.environment;
    const rulesChanged = !isDeepStrictEqual(
      before.defaultNotifications,
      after.defaultNotifications,
    );
    if (!environmentChanged && !rulesChanged) {
      return [];
    }
    const inherited = new Map<string, Promise<ConfigIssue[]>>();
    const issues: ConfigIssue[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.deps.jobs.list({ groupId: before.id, limit: 200, cursor });
      for (const job of page.items) {
        if (job.environment === null) {
          if (environmentChanged) {
            issues.push(...(await this.#memberIssues(job, after.environment)));
          }
          continue;
        }
        if (job.environment === after.environment) {
          continue;
        }
        const own = job.environment;
        const found =
          inherited.get(own) ??
          inheritedNotificationIssues(this.deps.registry, this.deps.connections, after, own);
        inherited.set(own, found);
        issues.push(
          ...(await found).map((issue) => ({
            path: issue.path,
            message: `Job "${job.name}" would break in environment "${own}": ${issue.message}`,
          })),
        );
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    return issues;
  }

  async #memberIssues(job: Job, environment: string | null): Promise<ConfigIssue[]> {
    const catalog = await loadConnections(this.deps.connections, job.connectionRefs, environment);
    const bound = bindJob(this.deps.registry, job, catalog);

    return bound.isErr()
      ? bound.error.issues.map((issue) => ({
          path: 'environment',
          message: `Job "${job.name}" would break: ${issue.path}: ${issue.message}`,
        }))
      : [];
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
