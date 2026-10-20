import { err, type Result } from 'neverthrow';

import {
  type ConnectionCatalog,
  type ConnectionRef,
  type EndpointKind,
  type TargetRef,
  endpointProvider,
  findEndpoint,
} from '../domain/connection.js';
import type { TriggerRef } from '../domain/job.js';
import type { ConfigError, ConfigIssue } from '../shared/errors.js';
import { mergePatch } from '../shared/merge-patch.js';
import type { ProviderRegistry } from './registry.js';
import type { BoundByKind, BoundTarget, BoundTrigger } from './sdk.js';

export interface UsedConnection {
  readonly key: string;
  readonly endpoint: string | undefined;
  readonly version: number;
}

export interface ResolvedTarget {
  readonly target: BoundTarget;
  readonly connection: UsedConnection | undefined;
}

export interface ResolvedTrigger {
  readonly trigger: BoundTrigger;
  readonly connection: UsedConnection | undefined;
}

interface ConnectedRef {
  readonly type: string;
  readonly config?: unknown;
  readonly connection?: ConnectionRef | undefined;
}

const nested = (prefix: string, issues: readonly ConfigIssue[]): ConfigIssue[] =>
  issues.map((issue) => ({
    path: issue.path ? `${prefix}.${issue.path}` : prefix,
    message: issue.message,
  }));

const ENDPOINT_NOUN: Record<EndpointKind, string> = { target: 'target', trigger: 'event source' };

function resolveConnected<K extends EndpointKind>(
  registry: ProviderRegistry,
  kind: K,
  ref: ConnectedRef,
  connections: ConnectionCatalog,
): Result<{ bound: BoundByKind[K]; connection: UsedConnection | undefined }, ConfigError> {
  const subject = kind === 'target' ? 'Target' : 'Trigger';
  const invalid = (issues: readonly ConfigIssue[]): ConfigError => ({
    code: 'invalid_config',
    message: `Invalid ${kind} configuration`,
    issues,
  });
  const fail = (path: string, message: string) => err(invalid([{ path, message }]));

  const found = registry.get(kind, ref.type);
  if (found.isErr()) {
    return fail('type', found.error.message);
  }
  const provider = found.value;
  const use = ref.connection;
  if (!use) {
    if (provider.connectionRequired === true) {
      return fail(
        'connection',
        `${subject} "${ref.type}" needs a "${provider.connectionType ?? ''}" connection`,
      );
    }

    return provider
      .bind(ref.config, { connections })
      .map((bound) => ({ bound, connection: undefined }))
      .mapErr((e) => invalid(nested('config', e.issues)));
  }

  if (provider.connectionType === undefined) {
    return fail('connection', `${subject} "${ref.type}" does not use connections`);
  }
  const connection = connections.get(use.key);
  if (!connection) {
    return fail('connection.key', `No connection named "${use.key}"`);
  }
  if (connection.type !== provider.connectionType) {
    return fail(
      'connection.key',
      `Connection "${use.key}" is a "${connection.type}" connection, but ${kind} "${ref.type}" needs "${provider.connectionType}"`,
    );
  }
  const validConnection = registry
    .get('connection', connection.type)
    .andThen((p) => p.bind(connection.config));
  if (validConnection.isErr()) {
    return fail(
      'connection.key',
      `Connection "${use.key}" is invalid: ${validConnection.error.message}`,
    );
  }

  let config = ref.config;
  if (use.endpoint !== undefined) {
    const endpoint = findEndpoint(connection, use.endpoint);
    if (!endpoint) {
      return fail(
        'connection.endpoint',
        `Connection "${use.key}" has no endpoint "${use.endpoint}"`,
      );
    }
    const saved = endpointProvider(endpoint);
    if (saved.kind !== kind) {
      return fail(
        'connection.endpoint',
        `Endpoint "${use.key}/${use.endpoint}" is ${saved.kind === 'target' ? 'a' : 'an'} ${ENDPOINT_NOUN[saved.kind]} endpoint`,
      );
    }
    if (saved.ref.type !== ref.type) {
      return fail(
        'type',
        `Endpoint "${use.key}/${use.endpoint}" is a "${saved.ref.type}" ${ENDPOINT_NOUN[kind]}`,
      );
    }
    config = ref.config === undefined ? saved.ref.config : mergePatch(saved.ref.config, ref.config);
  }

  return provider
    .bind(config, {
      connection: { key: connection.key, version: connection.version, config: connection.config },
      connections,
    })
    .map((bound) => ({
      bound,
      connection: { key: connection.key, endpoint: use.endpoint, version: connection.version },
    }))
    .mapErr((e) => invalid(nested('config', e.issues)));
}

export const resolveTarget = (
  registry: ProviderRegistry,
  ref: TargetRef,
  connections: ConnectionCatalog,
): Result<ResolvedTarget, ConfigError> =>
  resolveConnected(registry, 'target', ref, connections).map(({ bound, connection }) => ({
    target: bound,
    connection,
  }));

export const resolveTrigger = (
  registry: ProviderRegistry,
  ref: Pick<TriggerRef, 'type' | 'config' | 'connection'>,
  connections: ConnectionCatalog,
): Result<ResolvedTrigger, ConfigError> =>
  resolveConnected(registry, 'trigger', ref, connections).map(({ bound, connection }) => ({
    trigger: bound,
    connection,
  }));

const refId = (ref: ConnectionRef) => `${ref.key}/${ref.endpoint ?? ''}`;

const unique = (refs: readonly ConnectionRef[]): ConnectionRef[] => [
  ...new Map(refs.map((r) => [refId(r), r])).values(),
];

export function targetConnectionRefs(registry: ProviderRegistry, ref: TargetRef): ConnectionRef[] {
  const own = ref.connection ? [ref.connection] : [];
  const children = registry
    .get('target', ref.type)
    .map((provider) => provider.connectionRefs?.(ref.config) ?? [])
    .unwrapOr([]);

  return unique([...own, ...children]);
}

export const jobConnectionRefs = (
  registry: ProviderRegistry,
  spec: { readonly trigger: Pick<TriggerRef, 'connection'>; readonly target: TargetRef },
): ConnectionRef[] =>
  unique([
    ...(spec.trigger.connection ? [spec.trigger.connection] : []),
    ...targetConnectionRefs(registry, spec.target),
  ]);
