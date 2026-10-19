import {
  type Clock,
  type ConfigError,
  type ConfigIssue,
  type ConflictError,
  type Connection,
  type ConnectionInUseError,
  type ConnectionQuery,
  type ConnectionRepository,
  ConnectionSpec,
  type ConnectionTestResult,
  type Job,
  type JobRepository,
  type NotFoundError,
  type Page,
  type ProviderRegistry,
  type Result,
  type SecretResolver,
  type VersionConflictError,
  configErrorFromZod,
  connectionCatalog,
  connectionInUse,
  createConnection,
  err,
  newConnectionId,
  notFound,
  ok,
  resolveTarget,
  toError,
} from '@cloud-trigger/core';

import { loadConnections } from './config-validation.js';

export interface ConnectionServiceDeps {
  readonly connections: ConnectionRepository;
  readonly jobs: JobRepository;
  readonly registry: ProviderRegistry;
  readonly secrets: SecretResolver;
  readonly clock: Clock;
}

export interface ConnectionTestOptions {
  readonly timeoutMs?: number | undefined;
}

const invalid = (issues: readonly ConfigIssue[]): ConfigError => ({
  code: 'invalid_config',
  message: 'Invalid connection configuration',
  issues,
});

const prefixed = (prefix: string, issues: readonly ConfigIssue[]): ConfigIssue[] =>
  issues.map((issue) => ({
    path: issue.path ? `${prefix}.${issue.path}` : prefix,
    message: issue.message,
  }));

const DEFAULT_TEST_TIMEOUT_MS = 10_000;

export class ConnectionService {
  constructor(private readonly deps: ConnectionServiceDeps) {}

  list(query: ConnectionQuery): Promise<Page<Connection>> {
    return this.deps.connections.list(query);
  }

  async get(key: string): Promise<Result<Connection, NotFoundError>> {
    const connection = await this.deps.connections.get(key);

    return connection ? ok(connection) : err(notFound('Connection', key));
  }

  usages(key: string): Promise<readonly Job[]> {
    return this.deps.jobs.findByConnection(key);
  }

  validate(raw: unknown): Result<ConnectionSpec, ConfigError> {
    const parsed = ConnectionSpec.safeParse(raw);
    if (!parsed.success) {
      return err(configErrorFromZod(parsed.error, 'connection'));
    }
    const spec = parsed.data;
    const provider = this.deps.registry.get('connection', spec.type);
    if (provider.isErr()) {
      return err(invalid([{ path: 'type', message: provider.error.message }]));
    }
    const bound = provider.value.bind(spec.config);
    if (bound.isErr()) {
      return err(invalid(prefixed('config', bound.error.issues)));
    }
    const draft = createConnection({
      id: newConnectionId(),
      spec,
      now: this.deps.clock.now(),
    });
    const catalog = connectionCatalog([draft]);
    const issues = spec.endpoints.flatMap((endpoint, index) => {
      const resolved = resolveTarget(
        this.deps.registry,
        { ...endpoint.target, connection: { key: spec.key } },
        catalog,
      );

      return resolved.isOk()
        ? []
        : resolved.error.issues.map((issue) => ({
            path: issue.path.startsWith('connection')
              ? `endpoints.${index}.target.type`
              : `endpoints.${index}.target.${issue.path}`,
            message: issue.message,
          }));
    });

    return issues.length === 0 ? ok(spec) : err(invalid(issues));
  }

  async create(raw: unknown): Promise<Result<Connection, ConfigError | ConflictError>> {
    const spec = this.validate(raw);
    if (spec.isErr()) {
      return err(spec.error);
    }

    return this.deps.connections.insert(
      createConnection({ id: newConnectionId(), spec: spec.value, now: this.deps.clock.now() }),
    );
  }

  async update(
    key: string,
    raw: unknown,
    expectedVersion: number,
  ): Promise<Result<Connection, ConfigError | NotFoundError | VersionConflictError>> {
    const spec = this.validate(raw);
    if (spec.isErr()) {
      return err(spec.error);
    }
    if (spec.value.key !== key) {
      return err(invalid([{ path: 'key', message: 'A connection key cannot change' }]));
    }
    const current = await this.deps.connections.get(key);
    if (!current) {
      return err(notFound('Connection', key));
    }
    const next: Connection = {
      ...current,
      ...spec.value,
      version: current.version + 1,
      updatedAt: this.deps.clock.now(),
    };
    const broken = await this.#brokenJobs(next);
    if (broken.length > 0) {
      return err(invalid(broken));
    }

    return this.deps.connections.update(
      key,
      { spec: spec.value, updatedAt: next.updatedAt },
      expectedVersion,
    );
  }

  async delete(key: string): Promise<Result<void, NotFoundError | ConnectionInUseError>> {
    const users = await this.deps.jobs.findByConnection(key);
    if (users.length > 0) {
      return err(
        connectionInUse(
          key,
          users.map((job) => job.id),
        ),
      );
    }

    return (await this.deps.connections.delete(key))
      ? ok(undefined)
      : err(notFound('Connection', key));
  }

  async test(
    raw: { readonly type: string; readonly config: unknown },
    options: ConnectionTestOptions = {},
  ): Promise<Result<ConnectionTestResult, ConfigError>> {
    const bound = this.deps.registry
      .get('connection', raw.type)
      .mapErr((e) => invalid([{ path: 'type', message: e.message }]))
      .andThen((provider) =>
        provider.bind(raw.config).mapErr((e) => invalid(prefixed('config', e.issues))),
      );
    if (bound.isErr()) {
      return err(bound.error);
    }
    const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS);
    try {
      return ok(
        await bound.value.test({ secrets: this.deps.secrets, signal, now: this.deps.clock.now() }),
      );
    } catch (error: unknown) {
      return ok(err({ message: toError(error).message }));
    }
  }

  async #brokenJobs(next: Connection): Promise<ConfigIssue[]> {
    const jobs = await this.deps.jobs.findByConnection(next.key);
    const issues: ConfigIssue[] = [];
    for (const job of jobs) {
      const loaded = await loadConnections(this.deps.connections, job.connectionRefs);
      const catalog = new Map(loaded).set(next.key, next);
      const resolved = resolveTarget(this.deps.registry, job.target, catalog);
      if (resolved.isErr()) {
        issues.push(
          ...resolved.error.issues.map((issue) => ({
            path: 'endpoints',
            message: `Job "${job.name}" would break: target.${issue.path}: ${issue.message}`,
          })),
        );
      }
    }

    return issues;
  }
}
