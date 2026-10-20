import type { ConnectionSpec } from '../domain/connection.js';
import { endpointProvider, withEndpointProvider } from '../domain/connection.js';
import type { GroupSpec } from '../domain/group.js';
import type { JobSpec } from '../domain/job.js';
import type { NotificationDelivery } from '../domain/notification.js';
import type { ProviderRef } from '../domain/provider-ref.js';
import type { WorkflowRun } from '../domain/workflow-run.js';
import type { InlineJobSpec, WorkflowNode, WorkflowSpec } from '../domain/workflow.js';
import { mapSecrets } from './redact.js';
import type { ProviderRegistry } from './registry.js';
import type { JsonSchema, ProviderKind } from './sdk.js';

export type SecretLeaf = (secret: unknown) => unknown;

type InlineRefs = Pick<InlineJobSpec, 'input' | 'target' | 'notifications'>;
type JobRefs = InlineRefs & Pick<JobSpec, 'trigger'>;

export class SecretFields {
  readonly #schemas = new Map<string, JsonSchema | undefined>();

  constructor(private readonly registry: ProviderRegistry) {}

  job<T extends JobRefs>(job: T, leaf: SecretLeaf): T {
    return {
      ...this.#inline(job, leaf),
      trigger: this.#ref('trigger', job.trigger, leaf),
    };
  }

  group<T extends Pick<GroupSpec, 'defaultNotifications'>>(group: T, leaf: SecretLeaf): T {
    return {
      ...group,
      defaultNotifications: group.defaultNotifications.map((n) => ({
        ...n,
        notifier: this.#ref('notifier', n.notifier, leaf),
      })),
    };
  }

  workflow<T extends Pick<WorkflowSpec, 'nodes' | 'schedule'>>(workflow: T, leaf: SecretLeaf): T {
    return {
      ...workflow,
      nodes: this.#nodes(workflow.nodes, leaf),
      schedule: workflow.schedule && this.#ref('trigger', workflow.schedule, leaf),
    };
  }

  workflowRun(run: WorkflowRun, leaf: SecretLeaf): WorkflowRun {
    return { ...run, graph: { ...run.graph, nodes: this.#nodes(run.graph.nodes, leaf) } };
  }

  connection<T extends ConnectionSpec>(connection: T, leaf: SecretLeaf): T {
    return {
      ...connection,
      config: mapSecrets(this.schema('connection', connection.type), connection.config, leaf),
      endpoints: connection.endpoints.map((endpoint) => {
        const { kind, ref } = endpointProvider(endpoint);

        return withEndpointProvider(endpoint, this.#ref(kind, ref, leaf));
      }),
      overlays: connection.overlays.map((overlay) => ({
        ...overlay,
        ...(overlay.config !== undefined && {
          config: mapSecrets(this.schema('connection', connection.type), overlay.config, leaf),
        }),
        endpoints: overlay.endpoints.map((patch) => ({
          ...patch,
          config: mapSecrets(this.endpointSchema(connection, patch.key), patch.config, leaf),
        })),
      })),
    };
  }

  delivery(delivery: NotificationDelivery, leaf: SecretLeaf): NotificationDelivery {
    return { ...delivery, notifier: this.#ref('notifier', delivery.notifier, leaf) };
  }

  schema(kind: ProviderKind, type: string): JsonSchema | undefined {
    const key = `${kind}:${type}`;
    if (!this.#schemas.has(key)) {
      const provider = this.registry.get(kind, type);
      this.#schemas.set(key, provider.isOk() ? provider.value.jsonSchema() : undefined);
    }

    return this.#schemas.get(key);
  }

  endpointSchema(
    connection: Pick<ConnectionSpec, 'endpoints'>,
    key: string,
  ): JsonSchema | undefined {
    const endpoint = connection.endpoints.find((candidate) => candidate.key === key);
    if (!endpoint) {
      return undefined;
    }
    const { kind, ref } = endpointProvider(endpoint);

    return this.schema(kind, ref.type);
  }

  #inline<T extends InlineRefs>(job: T, leaf: SecretLeaf): T {
    return {
      ...job,
      input: this.#ref('input', job.input, leaf),
      target: this.#ref('target', job.target, leaf),
      notifications: job.notifications.map((n) => ({
        ...n,
        notifier: this.#ref('notifier', n.notifier, leaf),
      })),
    };
  }

  #nodes(nodes: readonly WorkflowNode[], leaf: SecretLeaf): WorkflowNode[] {
    return nodes.map((node) =>
      node.kind === 'inline' ? { ...node, job: this.#inline(node.job, leaf) } : node,
    );
  }

  #ref<R extends ProviderRef>(kind: ProviderKind, ref: R, leaf: SecretLeaf): R {
    return { ...ref, config: mapSecrets(this.schema(kind, ref.type), ref.config, leaf) };
  }
}
