import {
  type Job,
  type JobSpec,
  type Group,
  type GroupSpec,
  type JsonSchema,
  type NotificationDelivery,
  type ProviderKind,
  type ProviderRef,
  type ProviderRegistry,
  redactBySchema,
  restoreRedacted,
} from '@cloud-trigger/core';

export class JobRedactor {
  readonly #schemas = new Map<string, JsonSchema | undefined>();

  constructor(private readonly registry: ProviderRegistry) {}

  redact(job: Job): Job {
    return {
      ...job,
      trigger: { ...job.trigger, config: this.#redactRef('trigger', job.trigger) },
      input: { ...job.input, config: this.#redactRef('input', job.input) },
      target: { ...job.target, config: this.#redactRef('target', job.target) },
      notifications: job.notifications.map((n) => ({
        ...n,
        notifier: { ...n.notifier, config: this.#redactRef('notifier', n.notifier) },
      })),
    };
  }

  restore(next: JobSpec, previous: Job): JobSpec {
    const keep = (kind: ProviderKind, ref: ProviderRef, prev: ProviderRef | undefined): unknown =>
      prev && prev.type === ref.type
        ? restoreRedacted(this.#schema(kind, ref.type), ref.config, prev.config)
        : ref.config;

    return {
      ...next,
      trigger: { ...next.trigger, config: keep('trigger', next.trigger, previous.trigger) },
      input: { ...next.input, config: keep('input', next.input, previous.input) },
      target: { ...next.target, config: keep('target', next.target, previous.target) },
      notifications: next.notifications.map((n, i) => ({
        ...n,
        notifier: {
          ...n.notifier,
          config: keep('notifier', n.notifier, previous.notifications[i]?.notifier),
        },
      })),
    };
  }

  redactGroup(group: Group): Group {
    return {
      ...group,
      defaultNotifications: group.defaultNotifications.map((n) => ({
        ...n,
        notifier: { ...n.notifier, config: this.#redactRef('notifier', n.notifier) },
      })),
    };
  }

  restoreGroup(next: GroupSpec, previous: Group): GroupSpec {
    return {
      ...next,
      defaultNotifications: next.defaultNotifications.map((n, i) => {
        const prev = previous.defaultNotifications[i]?.notifier;

        return {
          ...n,
          notifier: {
            ...n.notifier,
            config:
              prev && prev.type === n.notifier.type
                ? restoreRedacted(
                    this.#schema('notifier', n.notifier.type),
                    n.notifier.config,
                    prev.config,
                  )
                : n.notifier.config,
          },
        };
      }),
    };
  }

  redactDelivery(delivery: NotificationDelivery): NotificationDelivery {
    return {
      ...delivery,
      notifier: { ...delivery.notifier, config: this.#redactRef('notifier', delivery.notifier) },
    };
  }

  #redactRef(kind: ProviderKind, ref: ProviderRef): unknown {
    return redactBySchema(this.#schema(kind, ref.type), ref.config);
  }

  #schema(kind: ProviderKind, type: string): JsonSchema | undefined {
    const key = `${kind}:${type}`;
    if (!this.#schemas.has(key)) {
      const provider = this.registry.get(kind, type);
      this.#schemas.set(key, provider.isOk() ? provider.value.jsonSchema() : undefined);
    }

    return this.#schemas.get(key);
  }
}
