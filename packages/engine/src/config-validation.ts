import {
  type BoundInput,
  type BoundNotifier,
  type BoundTarget,
  type BoundTrigger,
  type ConfigError,
  type JobSpec,
  type ProviderKind,
  type ProviderRef,
  type ProviderRegistry,
  type Result,
  err,
  ok,
} from '@cloud-trigger/core';

export interface BoundJob {
  readonly trigger: BoundTrigger;
  readonly input: BoundInput;
  readonly target: BoundTarget;
  readonly notifiers: readonly BoundNotifier[];
}

type Issue = ConfigError['issues'][number];

export function bindJob(
  registry: ProviderRegistry,
  spec: Pick<JobSpec, 'trigger' | 'input' | 'target' | 'notifications'>,
): Result<BoundJob, ConfigError> {
  const issues: Issue[] = [];
  const bindOne = <K extends ProviderKind>(kind: K, ref: ProviderRef, path: string) => {
    const bound = registry.get(kind, ref.type).andThen((provider) => provider.bind(ref.config));
    if (bound.isOk()) {
      return bound.value;
    }
    const e = bound.error;
    if (e.code === 'unknown_provider') {
      issues.push({ path: `${path}.type`, message: e.message });
    } else {
      issues.push(
        ...e.issues.map((i) => ({
          path: `${path}.config${i.path ? `.${i.path}` : ''}`,
          message: i.message,
        })),
      );
    }

    return undefined;
  };

  const trigger = bindOne('trigger', spec.trigger, 'trigger');
  const input = bindOne('input', spec.input, 'input');
  const target = bindOne('target', spec.target, 'target');
  const notifiers = spec.notifications.map((n, i) =>
    bindOne('notifier', n.notifier, `notifications.${i}.notifier`),
  );

  if (trigger && input && target && issues.length === 0) {
    return ok({ trigger, input, target, notifiers: notifiers.filter((n) => n !== undefined) });
  }

  return err({ code: 'invalid_config', message: 'Invalid job configuration', issues });
}
