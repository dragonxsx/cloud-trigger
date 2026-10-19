import {
  type BoundInput,
  type BoundNotifier,
  type BoundTarget,
  type BoundTrigger,
  type ConfigError,
  type ConnectionCatalog,
  type ConnectionRepository,
  type JobSpec,
  type ProviderKind,
  type ProviderRef,
  type ProviderRegistry,
  type ResolvedTarget,
  type Result,
  type TargetConnectionRef,
  connectionCatalog,
  emptyConnectionCatalog,
  err,
  ok,
  resolveTarget,
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

export const bindTrigger = (
  registry: ProviderRegistry,
  spec: Pick<JobSpec, 'trigger'>,
): Result<BoundTrigger, ConfigError> => bindRef(registry, 'trigger', spec.trigger, 'trigger');

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

  const trigger = collect(bindTrigger(registry, spec));
  const input = collect(bindRef(registry, 'input', spec.input, 'input'));
  const target = collect(
    resolveTarget(registry, spec.target, connections).mapErr((e) =>
      invalidJob(prefixed('target', e.issues)),
    ),
  );
  const notifiers = spec.notifications.map((n, i) =>
    collect(bindRef(registry, 'notifier', n.notifier, `notifications.${i}.notifier`)),
  );

  if (trigger && input && target && issues.length === 0) {
    return ok({
      trigger,
      input,
      target: target.target,
      connection: target.connection,
      notifiers: notifiers.filter((n) => n !== undefined),
    });
  }

  return err(invalidJob(issues));
}

export async function loadConnections(
  repository: ConnectionRepository | undefined,
  refs: readonly TargetConnectionRef[],
): Promise<ConnectionCatalog> {
  const keys = [...new Set(refs.map((ref) => ref.key))];
  if (!repository || keys.length === 0) {
    return emptyConnectionCatalog;
  }

  return connectionCatalog(await repository.getMany(keys));
}
