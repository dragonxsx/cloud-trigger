import {
  type Clock,
  type ConfigError,
  type ConfigIssue,
  type ConflictError,
  type Connection,
  type ConnectionCatalog,
  type ConnectionInUseError,
  type ConnectionQuery,
  type ConnectionRepository,
  ConnectionSpec,
  type ConnectionTestResult,
  type EndpointKind,
  type EnvironmentRepository,
  type Group,
  type GroupRepository,
  type Job,
  type JobRepository,
  type NotFoundError,
  type NotificationOutbox,
  type Page,
  type ProviderRegistry,
  type Result,
  type SecretResolver,
  type TargetRef,
  type VersionConflictError,
  configErrorFromZod,
  assertNever,
  connectionCatalog,
  connectionInUse,
  createConnection,
  err,
  newConnectionId,
  notFound,
  ok,
  endpointProvider,
  findEndpoint,
  mergePatch,
  notificationConnectionRefs,
  overlayConnection,
  resolveNotifier,
  resolveTarget,
  resolveTrigger,
  toError,
} from '@cloud-trigger/core';

import {
  bindJob,
  bindNotifications,
  loadConnections,
  unknownEnvironment,
} from './config-validation.js';
import { PolicyResolver } from './policies.js';

export interface ConnectionServiceDeps {
  readonly connections: ConnectionRepository;
  readonly jobs: JobRepository;
  readonly groups: GroupRepository;
  readonly environments: EnvironmentRepository;
  readonly outbox: NotificationOutbox;
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

const ENDPOINT_FIELD: Record<EndpointKind, string> = {
  target: 'target',
  trigger: 'source',
  notifier: 'notifier',
};

export interface ConnectionUsers {
  readonly jobs: readonly Job[];
  readonly groups: readonly Group[];
}

export class ConnectionService {
  readonly #policies: PolicyResolver;

  constructor(private readonly deps: ConnectionServiceDeps) {
    this.#policies = new PolicyResolver(deps.groups, deps.clock, 0);
  }

  list(query: ConnectionQuery): Promise<Page<Connection>> {
    return this.deps.connections.list(query);
  }

  async get(key: string): Promise<Result<Connection, NotFoundError>> {
    const connection = await this.deps.connections.get(key);

    return connection ? ok(connection) : err(notFound('Connection', key));
  }

  async usages(key: string): Promise<ConnectionUsers> {
    const [jobs, groups] = await Promise.all([
      this.deps.jobs.findByConnection(key),
      this.deps.groups.findByConnection(key),
    ]);

    return { jobs, groups };
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
    const issues = [
      ...this.#endpointIssues(draft, (index, field) => `endpoints.${index}.${field}`),
      ...spec.overlays.flatMap((_overlay, i) => this.#overlayIssues(draft, i)),
    ];

    return issues.length === 0 ? ok(spec) : err(invalid(issues));
  }

  #endpointIssues(
    connection: Connection,
    pathOf: (index: number, field: string) => string | undefined,
  ): ConfigIssue[] {
    const catalog = connectionCatalog([connection]);

    return connection.endpoints.flatMap((endpoint, index) => {
      const { kind, ref } = endpointProvider(endpoint);
      const prefix = pathOf(index, ENDPOINT_FIELD[kind]);
      if (prefix === undefined) {
        return [];
      }
      const resolved = this.#resolveEndpoint(
        kind,
        { ...ref, connection: { key: connection.key } },
        catalog,
      );
      const found = resolved.isOk() ? resolved.value : resolved.error.issues;

      return found.map((issue) => ({
        path: issue.path.startsWith('connection') ? `${prefix}.type` : `${prefix}.${issue.path}`,
        message: issue.message,
      }));
    });
  }

  #overlayIssues(draft: Connection, index: number): ConfigIssue[] {
    const overlay = draft.overlays[index];
    if (!overlay) {
      return [];
    }
    const at = `overlays.${index}`;
    const missing = overlay.endpoints.flatMap((patch, i) =>
      findEndpoint(draft, patch.key)
        ? []
        : [{ path: `${at}.endpoints.${i}.key`, message: `No endpoint "${patch.key}"` }],
    );
    if (missing.length > 0) {
      return missing;
    }
    const overlaid = overlayConnection(draft, overlay.environment);
    const bound = this.deps.registry
      .get('connection', draft.type)
      .andThen((provider) => provider.bind(overlaid.config));
    if (bound.isErr()) {
      return 'issues' in bound.error
        ? prefixed(`${at}.config`, bound.error.issues)
        : [{ path: `${at}.config`, message: bound.error.message }];
    }
    const patched = new Map(overlay.endpoints.map((patch, i) => [patch.key, i]));

    return this.#endpointIssues(overlaid, (i) => {
      const key = overlaid.endpoints[i]?.key;
      const patch = key === undefined ? undefined : patched.get(key);

      return patch === undefined ? undefined : `${at}.endpoints.${patch}`;
    });
  }

  async #unknownEnvironments(spec: ConnectionSpec): Promise<ConfigIssue[]> {
    const issues = await Promise.all(
      spec.overlays.map((overlay, i) =>
        unknownEnvironment(
          this.deps.environments,
          overlay.environment,
          `overlays.${i}.environment`,
        ),
      ),
    );

    return issues.flat();
  }

  #resolveEndpoint(
    kind: EndpointKind,
    ref: TargetRef,
    catalog: ConnectionCatalog,
  ): Result<readonly ConfigIssue[], ConfigError> {
    switch (kind) {
      case 'target':
        return resolveTarget(this.deps.registry, ref, catalog).map(() => []);
      case 'trigger':
        return resolveTrigger(this.deps.registry, ref, catalog).map(({ trigger }) =>
          trigger.source
            ? []
            : [{ path: 'type', message: `Trigger "${ref.type}" is not an event source` }],
        );
      case 'notifier':
        return resolveNotifier(this.deps.registry, ref, catalog).map(() => []);
      default:
        return assertNever(kind);
    }
  }

  async create(raw: unknown): Promise<Result<Connection, ConfigError | ConflictError>> {
    const spec = this.validate(raw);
    if (spec.isErr()) {
      return err(spec.error);
    }
    const unknown = await this.#unknownEnvironments(spec.value);
    if (unknown.length > 0) {
      return err(invalid(unknown));
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
    const unknown = await this.#unknownEnvironments(spec.value);
    if (unknown.length > 0) {
      return err(invalid(unknown));
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
    const broken = [
      ...(await this.#brokenJobs(next)),
      ...(await this.#brokenGroups(next)),
      ...(await this.#brokenDeliveries(next)),
    ];
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
    const [{ jobs, groups }, deliveries] = await Promise.all([
      this.usages(key),
      this.deps.outbox.listOpenByConnection(key),
    ]);
    if (jobs.length > 0 || groups.length > 0 || deliveries.length > 0) {
      return err(
        connectionInUse(key, {
          jobIds: jobs.map((job) => job.id),
          groupIds: groups.map((group) => group.id),
          deliveryIds: deliveries.map((delivery) => delivery.id),
        }),
      );
    }

    return (await this.deps.connections.delete(key))
      ? ok(undefined)
      : err(notFound('Connection', key));
  }

  async test(
    raw: { readonly type: string; readonly config: unknown; readonly overlay?: unknown },
    options: ConnectionTestOptions = {},
  ): Promise<Result<ConnectionTestResult, ConfigError>> {
    const config = raw.overlay === undefined ? raw.config : mergePatch(raw.config, raw.overlay);
    const bound = this.deps.registry
      .get('connection', raw.type)
      .mapErr((e) => invalid([{ path: 'type', message: e.message }]))
      .andThen((provider) =>
        provider.bind(config).mapErr((e) => invalid(prefixed('config', e.issues))),
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
      const environment = await this.#policies.environment(job);
      const loaded = await loadConnections(this.deps.connections, job.connectionRefs, environment);
      const catalog = new Map(loaded).set(next.key, overlayConnection(next, environment));
      const resolved = bindJob(this.deps.registry, job, catalog);
      if (resolved.isErr()) {
        issues.push(
          ...resolved.error.issues
            .filter((issue) => /^(trigger|target|notifications)\b/.test(issue.path))
            .map((issue) => ({
              path: 'endpoints',
              message: `Job "${job.name}" would break: ${issue.path}: ${issue.message}`,
            })),
        );
      }
    }

    return issues;
  }

  async #brokenGroups(next: Connection): Promise<ConfigIssue[]> {
    const groups = await this.deps.groups.findByConnection(next.key);
    const issues: ConfigIssue[] = [];
    for (const group of groups) {
      const rules = group.defaultNotifications;
      const loaded = await loadConnections(
        this.deps.connections,
        notificationConnectionRefs(rules),
        group.environment,
      );
      const catalog = new Map(loaded).set(next.key, overlayConnection(next, group.environment));
      const bound = bindNotifications(this.deps.registry, rules, catalog, 'defaultNotifications');
      if (bound.isErr()) {
        issues.push(
          ...bound.error.issues.map((issue) => ({
            path: 'endpoints',
            message: `Group "${group.name}" would break: ${issue.path}: ${issue.message}`,
          })),
        );
      }
    }

    return issues;
  }

  // A queued delivery resolves its notifier on every attempt, so it outlives the rule that queued it.
  async #brokenDeliveries(next: Connection): Promise<ConfigIssue[]> {
    const deliveries = await this.deps.outbox.listOpenByConnection(next.key);

    return deliveries.flatMap((delivery) =>
      resolveNotifier(
        this.deps.registry,
        delivery.notifier,
        new Map([[next.key, overlayConnection(next, delivery.environment)]]),
      ).match(
        () => [],
        (error) =>
          error.issues.map((issue) => ({
            path: 'endpoints',
            message: `Queued notification ${delivery.key} would fail: ${issue.path}: ${issue.message}`,
          })),
      ),
    );
  }
}
