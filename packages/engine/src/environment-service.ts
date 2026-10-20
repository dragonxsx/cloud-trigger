import {
  type Clock,
  type ConfigError,
  type ConflictError,
  type ConnectionRepository,
  type Environment,
  type EnvironmentInUseError,
  type EnvironmentQuery,
  type EnvironmentRepository,
  EnvironmentSpec,
  type GroupRepository,
  type JobRepository,
  type NotFoundError,
  type Page,
  type Result,
  type VersionConflictError,
  type WorkflowRepository,
  configErrorFromZod,
  createEnvironment,
  environmentInUse,
  err,
  newEnvironmentId,
  notFound,
  ok,
} from '@cloud-trigger/core';

export interface EnvironmentServiceDeps {
  readonly environments: EnvironmentRepository;
  readonly connections: ConnectionRepository;
  readonly jobs: JobRepository;
  readonly groups: GroupRepository;
  readonly workflows: WorkflowRepository;
  readonly clock: Clock;
}

export class EnvironmentService {
  constructor(private readonly deps: EnvironmentServiceDeps) {}

  list(query: EnvironmentQuery): Promise<Page<Environment>> {
    return this.deps.environments.list(query);
  }

  async get(key: string): Promise<Result<Environment, NotFoundError>> {
    const environment = await this.deps.environments.get(key);

    return environment ? ok(environment) : err(notFound('Environment', key));
  }

  async create(raw: unknown): Promise<Result<Environment, ConfigError | ConflictError>> {
    const parsed = EnvironmentSpec.safeParse(raw);
    if (!parsed.success) {
      return err(configErrorFromZod(parsed.error, 'environment'));
    }

    return this.deps.environments.insert(
      createEnvironment({ id: newEnvironmentId(), spec: parsed.data, now: this.deps.clock.now() }),
    );
  }

  async update(
    key: string,
    raw: unknown,
    expectedVersion: number,
  ): Promise<Result<Environment, ConfigError | NotFoundError | VersionConflictError>> {
    const parsed = EnvironmentSpec.safeParse(raw);
    if (!parsed.success) {
      return err(configErrorFromZod(parsed.error, 'environment'));
    }
    if (parsed.data.key !== key) {
      return err({
        code: 'invalid_config',
        message: 'Invalid environment',
        issues: [{ path: 'key', message: 'An environment key cannot change' }],
      });
    }

    return this.deps.environments.update(
      key,
      { spec: parsed.data, updatedAt: this.deps.clock.now() },
      expectedVersion,
    );
  }

  async delete(key: string): Promise<Result<void, NotFoundError | EnvironmentInUseError>> {
    const [jobs, groups, workflows, connections] = await Promise.all([
      this.deps.jobs.findByEnvironment(key),
      this.deps.groups.findByEnvironment(key),
      this.deps.workflows.findByEnvironment(key),
      this.deps.connections.findByEnvironment(key),
    ]);
    if (jobs.length + groups.length + workflows.length + connections.length > 0) {
      return err(
        environmentInUse(key, {
          jobIds: jobs.map((job) => job.id),
          groupIds: groups.map((group) => group.id),
          workflowIds: workflows.map((workflow) => workflow.id),
          connectionKeys: connections.map((connection) => connection.key),
        }),
      );
    }

    return (await this.deps.environments.delete(key))
      ? ok(undefined)
      : err(notFound('Environment', key));
  }
}
