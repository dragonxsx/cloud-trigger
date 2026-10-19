import {
  type Connection,
  type ConnectionSpec,
  type Job,
  type JobSpec,
  type Group,
  type GroupSpec,
  type InlineJobSpec,
  type Workflow,
  type WorkflowNode,
  type WorkflowRun,
  type WorkflowSpec,
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

  #redactInline(job: InlineJobSpec): InlineJobSpec {
    return {
      ...job,
      input: { ...job.input, config: this.#redactRef('input', job.input) },
      target: { ...job.target, config: this.#redactRef('target', job.target) },
      notifications: job.notifications.map((n) => ({
        ...n,
        notifier: { ...n.notifier, config: this.#redactRef('notifier', n.notifier) },
      })),
    };
  }

  #redactNodes(nodes: readonly WorkflowNode[]): WorkflowNode[] {
    return nodes.map((node) =>
      node.kind === 'inline' ? { ...node, job: this.#redactInline(node.job) } : node,
    );
  }

  redactWorkflow(workflow: Workflow): Workflow {
    return {
      ...workflow,
      nodes: this.#redactNodes(workflow.nodes),
      ...(workflow.schedule && {
        schedule: {
          ...workflow.schedule,
          config: this.#redactRef('trigger', workflow.schedule),
        },
      }),
    };
  }

  redactWorkflowRun(run: WorkflowRun): WorkflowRun {
    return { ...run, graph: { ...run.graph, nodes: this.#redactNodes(run.graph.nodes) } };
  }

  restoreWorkflow(next: WorkflowSpec, previous: Workflow): WorkflowSpec {
    const keep = (kind: ProviderKind, ref: ProviderRef, prev: ProviderRef | undefined): unknown =>
      prev && prev.type === ref.type
        ? restoreRedacted(this.#schema(kind, ref.type), ref.config, prev.config)
        : ref.config;

    return {
      ...next,
      nodes: next.nodes.map((node) => {
        const before = previous.nodes.find((candidate) => candidate.key === node.key);
        if (node.kind !== 'inline' || before?.kind !== 'inline') {
          return node;
        }

        return {
          ...node,
          job: {
            ...node.job,
            input: { ...node.job.input, config: keep('input', node.job.input, before.job.input) },
            target: {
              ...node.job.target,
              config: keep('target', node.job.target, before.job.target),
            },
            notifications: node.job.notifications.map((n, i) => ({
              ...n,
              notifier: {
                ...n.notifier,
                config: keep('notifier', n.notifier, before.job.notifications[i]?.notifier),
              },
            })),
          },
        };
      }),
      schedule:
        next.schedule === null
          ? null
          : {
              ...next.schedule,
              config: keep('trigger', next.schedule, previous.schedule ?? undefined),
            },
    };
  }

  redactConnection(connection: Connection): Connection {
    return {
      ...connection,
      config: this.#redactRef('connection', connection),
      endpoints: connection.endpoints.map((endpoint) => ({
        ...endpoint,
        target: { ...endpoint.target, config: this.#redactRef('target', endpoint.target) },
      })),
    };
  }

  restoreConnection(next: ConnectionSpec, previous: Connection): ConnectionSpec {
    return {
      ...next,
      config: this.restoreConnectionConfig(next, previous),
      endpoints: next.endpoints.map((endpoint) => {
        const before = previous.endpoints.find((candidate) => candidate.key === endpoint.key);

        return before && before.target.type === endpoint.target.type
          ? {
              ...endpoint,
              target: {
                ...endpoint.target,
                config: restoreRedacted(
                  this.#schema('target', endpoint.target.type),
                  endpoint.target.config,
                  before.target.config,
                ),
              },
            }
          : endpoint;
      }),
    };
  }

  restoreConnectionConfig(
    next: Pick<ConnectionSpec, 'type' | 'config'>,
    previous: Pick<Connection, 'type' | 'config'>,
  ): unknown {
    return next.type === previous.type
      ? restoreRedacted(this.#schema('connection', next.type), next.config, previous.config)
      : next.config;
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
