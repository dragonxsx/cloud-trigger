import { err, ok, type Result } from 'neverthrow';
import { z } from 'zod';

import {
  type ConnectionRef,
  ConnectionSpec,
  type EndpointKind,
  connectionCatalog,
  createConnection,
  emptyConnectionCatalog,
  newEndpoint,
} from '../domain/connection.js';
import { newConnectionId } from '../domain/ids.js';
import { type Job, JobSpec } from '../domain/job.js';
import { slugKey } from '../domain/slug.js';
import { assertNever } from '../shared/assert-never.js';
import type { ConfigError, ConfigIssue } from '../shared/errors.js';
import { resolveNotifier, resolveTarget, resolveTrigger } from './connections.js';
import type { ProviderRegistry } from './registry.js';
import { BASE_URL_OPTION } from './sdk.js';

export const ExtractSlot = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('target') }).meta({ title: 'Target' }),
  z.object({ kind: z.literal('trigger') }).meta({ title: 'Trigger' }),
  z
    .object({ kind: z.literal('notification'), index: z.int().min(0) })
    .meta({ title: 'Notification rule' }),
]);
export type ExtractSlot = z.output<typeof ExtractSlot>;

export interface ExtractRequest {
  readonly slot: ExtractSlot;
  readonly key: string;
  readonly name?: string | undefined;
  readonly endpoint?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly now: Date;
}

export interface ExtractDraft {
  readonly connection: ConnectionSpec;
  readonly endpoint: string;
  readonly spec: JobSpec;
  readonly warnings: readonly ConfigIssue[];
}

interface SlotRef {
  readonly type: string;
  readonly config: unknown;
  readonly connection?: ConnectionRef | undefined;
}

interface Slot {
  readonly kind: EndpointKind;
  readonly path: string;
  readonly ref: SlotRef;
  readonly rewire: (connection: ConnectionRef) => JobSpec;
}

const invalid = (issues: readonly ConfigIssue[]): ConfigError => ({
  code: 'invalid_config',
  message: 'Cannot extract a connection',
  issues,
});

const connected = <R extends SlotRef>(ref: R, connection: ConnectionRef): R => ({
  ...ref,
  connection,
  config: {},
});

function slotOf(spec: JobSpec, slot: ExtractSlot): Result<Slot, ConfigError> {
  switch (slot.kind) {
    case 'target':
      return ok({
        kind: 'target',
        path: 'target',
        ref: spec.target,
        rewire: (c) => ({ ...spec, target: connected(spec.target, c) }),
      });
    case 'trigger':
      return ok({
        kind: 'trigger',
        path: 'trigger',
        ref: spec.trigger,
        rewire: (c) => ({ ...spec, trigger: connected(spec.trigger, c) }),
      });
    case 'notification': {
      const rule = spec.notifications[slot.index];
      if (!rule) {
        return err(
          invalid([{ path: `notifications.${slot.index}`, message: 'No such notification rule' }]),
        );
      }

      return ok({
        kind: 'notifier',
        path: `notifications.${slot.index}.notifier`,
        ref: rule.notifier,
        rewire: (c) => ({
          ...spec,
          notifications: spec.notifications.map((r, i) =>
            i === slot.index ? { ...r, notifier: connected(r.notifier, c) } : r,
          ),
        }),
      });
    }
    default:
      return assertNever(slot);
  }
}

const resolveSlot = (
  registry: ProviderRegistry,
  kind: EndpointKind,
  ref: SlotRef,
  catalog: Parameters<typeof resolveTarget>[2],
): Result<unknown, ConfigError> => {
  switch (kind) {
    case 'target':
      return resolveTarget(registry, ref, catalog);
    case 'trigger':
      return resolveTrigger(registry, ref, catalog);
    case 'notifier':
      return resolveNotifier(registry, ref, catalog);
    default:
      return assertNever(kind);
  }
};

const under = (prefix: string, issues: readonly ConfigIssue[]): ConfigIssue[] =>
  issues.map((issue) => ({
    path:
      issue.path === BASE_URL_OPTION ? 'baseUrl' : issue.path ? `${prefix}.${issue.path}` : prefix,
    message: issue.message,
  }));

export function extractionSuggestion(
  registry: ProviderRegistry,
  job: Job,
  slot: ExtractSlot,
): string | undefined {
  const found = slotOf(JobSpec.parse(job), slot);
  if (found.isErr()) {
    return undefined;
  }
  const { kind, ref } = found.value;
  const extracted = registry
    .get(kind, ref.type)
    .map((provider) => provider.extractConnection?.(ref.config, {}));

  return extracted.isOk() && extracted.value?.isOk()
    ? extracted.value.value.suggestedName
    : undefined;
}

export function extractJobConnection(
  registry: ProviderRegistry,
  job: Job,
  request: ExtractRequest,
): Result<ExtractDraft, ConfigError> {
  const spec = JobSpec.parse(job);
  const found = slotOf(spec, request.slot);
  if (found.isErr()) {
    return err(found.error);
  }
  const { kind, path, ref, rewire } = found.value;
  if (ref.connection) {
    return err(
      invalid([
        {
          path: `${path}.connection`,
          message: `Already uses the "${ref.connection.key}" connection`,
        },
      ]),
    );
  }
  const provider = registry.get(kind, ref.type);
  if (provider.isErr()) {
    return err(invalid([{ path: `${path}.type`, message: provider.error.message }]));
  }
  const { connectionType, extractConnection } = provider.value;
  if (connectionType === undefined || extractConnection === undefined) {
    return err(
      invalid([
        { path: `${path}.type`, message: `"${ref.type}" cannot be moved onto a connection` },
      ]),
    );
  }
  const extracted = extractConnection(ref.config, { baseUrl: request.baseUrl });
  if (extracted.isErr()) {
    return err(invalid(under(`${path}.config`, extracted.error.issues)));
  }
  const { connection: config, config: endpointConfig, suggestedName } = extracted.value;
  const endpoint = request.endpoint ?? slugKey(job.name, 'default');
  const parsed = ConnectionSpec.safeParse({
    key: request.key,
    name: (request.name ?? suggestedName ?? job.name).slice(0, 200),
    description: `Extracted from job "${job.name}"`,
    type: connectionType,
    config,
    endpoints: [
      newEndpoint(
        kind,
        { key: endpoint, name: job.name, description: '' },
        { type: ref.type, config: endpointConfig },
      ),
    ],
    overlays: [],
  });
  if (!parsed.success) {
    return err(
      invalid(
        parsed.error.issues.map((issue) => ({
          path: issue.path[0] === 'endpoints' ? 'endpoint' : issue.path.map(String).join('.'),
          message: issue.message,
        })),
      ),
    );
  }
  const reference: ConnectionRef = { key: parsed.data.key, endpoint };
  const next = rewire(reference);
  const catalog = connectionCatalog([
    createConnection({ id: newConnectionId(), spec: parsed.data, now: request.now }),
  ]);
  const before = resolveSlot(registry, kind, ref, emptyConnectionCatalog);
  const after = resolveSlot(registry, kind, connected(ref, reference), catalog);
  const broken = [before, after].flatMap((r) => (r.isErr() ? r.error.issues : []));
  if (broken.length > 0) {
    return err(invalid(under(path, broken)));
  }

  return ok({
    connection: parsed.data,
    endpoint,
    spec: next,
    warnings: under(`${path}.config`, extracted.value.warnings),
  });
}
