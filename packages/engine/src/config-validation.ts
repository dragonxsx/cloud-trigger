import {
  type BoundInput,
  type BoundNotifier,
  type BoundTarget,
  type BoundTrigger,
  type ConfigError,
  type ConnectionCatalog,
  type ConnectionRepository,
  type JobSpec,
  type NotificationRule,
  type ProviderKind,
  type ProviderRef,
  type ProviderRegistry,
  type ResolvedTarget,
  type ResolvedTrigger,
  type Result,
  type ConnectionRef,
  connectionCatalog,
  emptyConnectionCatalog,
  err,
  ok,
  resolveNotifier,
  resolveTarget,
  resolveTrigger,
} from '@cloud-trigger/core';

export interface BoundJob {
  readonly trigger: BoundTrigger;
  readonly input: BoundInput;
  readonly target: BoundTarget;
  readonly connection: ResolvedTarget['connection'];
  readonly notifiers: readonly BoundNotifier[];
}

type Issue = ConfigError['issues'][number];

const invalidJob = (issues: readonly Issue[]): ConfigError => ({
  code: 'invalid_config',
  message: 'Invalid job configuration',
  issues,
});

const prefixed = (prefix: string, issues: readonly Issue[]): Issue[] =>
  issues.map((issue) => ({
    path: issue.path ? `${prefix}.${issue.path}` : prefix,
    message: issue.message,
  }));

function bindRef<K extends ProviderKind>(
  registry: ProviderRegistry,
  kind: K,
  ref: ProviderRef,
  path: string,
) {
  return registry
    .get(kind, ref.type)
    .mapErr((e) => invalidJob([{ path: `${path}.type`, message: e.message }]))
    .andThen((provider) =>
      provider.bind(ref.config).mapErr((e) => invalidJob(prefixed(`${path}.config`, e.issues))),
    );
}

export const resolveJobTrigger = (
  registry: ProviderRegistry,
  spec: Pick<JobSpec, 'trigger'>,
  connections: ConnectionCatalog,
): Result<ResolvedTrigger, ConfigError> =>
  resolveTrigger(registry, spec.trigger, connections).mapErr((e) =>
    invalidJob(prefixed('trigger', e.issues)),
  );

export const bindTrigger = (
  registry: ProviderRegistry,
  spec: Pick<JobSpec, 'trigger'>,
  connections: ConnectionCatalog,
): Result<BoundTrigger, ConfigError> =>
  resolveJobTrigger(registry, spec, connections).map(({ trigger }) => trigger);

export function bindNotifications(
  registry: ProviderRegistry,
  rules: readonly Pick<NotificationRule, 'notifier'>[],
  connections: ConnectionCatalog,
  path: string,
): Result<BoundNotifier[], ConfigError> {
  const results = rules.map((rule, i) =>
    resolveNotifier(registry, rule.notifier, connections).mapErr((e) =>
      prefixed(`${path}.${i}.notifier`, e.issues),
    ),
  );
  const issues = results.flatMap((result) => (result.isErr() ? result.error : []));

  return issues.length > 0
    ? err(invalidJob(issues))
    : ok(results.flatMap((result) => (result.isOk() ? [result.value.notifier] : [])));
}

export function bindJob(
  registry: ProviderRegistry,
  spec: Pick<JobSpec, 'trigger' | 'input' | 'target' | 'notifications'>,
  connections: ConnectionCatalog,
): Result<BoundJob, ConfigError> {
  const issues: Issue[] = [];
  const collect = <T>(result: Result<T, ConfigError>): T | undefined => {
    if (result.isOk()) {
      return result.value;
    }
    issues.push(...result.error.issues);

    return undefined;
  };

  const trigger = collect(resolveJobTrigger(registry, spec, connections));
  const input = collect(bindRef(registry, 'input', spec.input, 'input'));
  const target = collect(
    resolveTarget(registry, spec.target, connections).mapErr((e) =>
      invalidJob(prefixed('target', e.issues)),
    ),
  );
  const notifiers = collect(
    bindNotifications(registry, spec.notifications, connections, 'notifications'),
  );

  if (trigger && input && target && notifiers && issues.length === 0) {
    return ok({
      trigger: trigger.trigger,
      input,
      target: target.target,
      connection: target.connection,
      notifiers,
    });
  }

  return err(invalidJob(issues));
}

export async function loadConnections(
  repository: ConnectionRepository | undefined,
  refs: readonly ConnectionRef[],
): Promise<ConnectionCatalog> {
  const keys = [...new Set(refs.map((ref) => ref.key))];
  if (!repository || keys.length === 0) {
    return emptyConnectionCatalog;
  }

  return connectionCatalog(await repository.getMany(keys));
}

export async function loadTrigger(
  registry: ProviderRegistry,
  repository: ConnectionRepository | undefined,
  spec: Pick<JobSpec, 'trigger'>,
): Promise<Result<BoundTrigger, ConfigError>> {
  const refs = spec.trigger.connection ? [spec.trigger.connection] : [];

  return bindTrigger(registry, spec, await loadConnections(repository, refs));
}
