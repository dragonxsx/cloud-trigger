import {
  type Connection,
  type ConnectionSpec,
  type Job,
  type JobSpec,
  type Group,
  type GroupSpec,
  type Workflow,
  type WorkflowRun,
  type WorkflowSpec,
  endpointProvider,
  findOverlay,
  SecretFields,
  withEndpointProvider,
  type JsonSchema,
  type NotificationDelivery,
  type ProviderKind,
  type ProviderRef,
  type ProviderRegistry,
  redactSecret,
  restoreRedacted,
} from '@cloud-trigger/core';

export class JobRedactor {
  readonly #fields: SecretFields;

  constructor(registry: ProviderRegistry) {
    this.#fields = new SecretFields(registry);
  }

  redact(job: Job): Job {
    return this.#fields.job(job, redactSecret);
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
    return this.#fields.group(group, redactSecret);
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

  redactWorkflow(workflow: Workflow): Workflow {
    return this.#fields.workflow(workflow, redactSecret);
  }

  redactWorkflowRun(run: WorkflowRun): WorkflowRun {
    return this.#fields.workflowRun(run, redactSecret);
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
    return this.#fields.connection(connection, redactSecret);
  }

  restoreConnection(next: ConnectionSpec, previous: Connection): ConnectionSpec {
    return {
      ...next,
      config: this.restoreConnectionConfig(next, previous),
      endpoints: next.endpoints.map((endpoint) => {
        const { kind, ref } = endpointProvider(endpoint);
        const found = previous.endpoints.find((candidate) => candidate.key === endpoint.key);
        const before = found && endpointProvider(found);

        return before && before.kind === kind && before.ref.type === ref.type
          ? withEndpointProvider(endpoint, {
              ...ref,
              config: restoreRedacted(this.#schema(kind, ref.type), ref.config, before.ref.config),
            })
          : endpoint;
      }),
      overlays:
        next.type === previous.type
          ? next.overlays.map((overlay) => {
              const before = findOverlay(previous, overlay.environment);

              return {
                ...overlay,
                ...(overlay.config !== undefined && {
                  config: this.restoreOverlayConfig(next, overlay, previous),
                }),
                endpoints: overlay.endpoints.map((patch) => ({
                  ...patch,
                  config: restoreRedacted(
                    this.#endpointSchema(next, patch.key),
                    patch.config,
                    before?.endpoints.find((candidate) => candidate.key === patch.key)?.config,
                  ),
                })),
              };
            })
          : next.overlays,
    };
  }

  restoreOverlayConfig(
    next: Pick<ConnectionSpec, 'type'>,
    overlay: { readonly environment: string; readonly config?: unknown },
    previous: Pick<Connection, 'type' | 'overlays'>,
  ): unknown {
    return next.type === previous.type
      ? restoreRedacted(
          this.#schema('connection', next.type),
          overlay.config,
          findOverlay(previous, overlay.environment)?.config,
        )
      : overlay.config;
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
    return this.#fields.delivery(delivery, redactSecret);
  }

  #schema(kind: ProviderKind, type: string): JsonSchema | undefined {
    return this.#fields.schema(kind, type);
  }

  #endpointSchema(
    connection: Pick<ConnectionSpec, 'endpoints'>,
    key: string,
  ): JsonSchema | undefined {
    return this.#fields.endpointSchema(connection, key);
  }
}
