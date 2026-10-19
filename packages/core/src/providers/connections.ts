import { err, type Result } from 'neverthrow';

import {
  type ConnectionCatalog,
  type TargetConnectionRef,
  type TargetRef,
  findEndpoint,
} from '../domain/connection.js';
import type { ConfigError, ConfigIssue } from '../shared/errors.js';
import { mergePatch } from '../shared/merge-patch.js';
import type { ProviderRegistry } from './registry.js';
import type { BoundTarget } from './sdk.js';

export interface ResolvedTarget {
  readonly target: BoundTarget;
  readonly connection:
    | { readonly key: string; readonly endpoint: string | undefined; readonly version: number }
    | undefined;
}

const nested = (prefix: string, issues: readonly ConfigIssue[]): ConfigIssue[] =>
  issues.map((issue) => ({
    path: issue.path ? `${prefix}.${issue.path}` : prefix,
    message: issue.message,
  }));

const invalidTarget = (issues: readonly ConfigIssue[]): ConfigError => ({
  code: 'invalid_config',
  message: 'Invalid target configuration',
  issues,
});

const fail = (path: string, message: string) => err(invalidTarget([{ path, message }]));

export function resolveTarget(
  registry: ProviderRegistry,
  ref: TargetRef,
  connections: ConnectionCatalog,
): Result<ResolvedTarget, ConfigError> {
  const found = registry.get('target', ref.type);
  if (found.isErr()) {
    return fail('type', found.error.message);
  }
  const provider = found.value;
  const use = ref.connection;
  if (!use) {
    if (provider.connectionRequired === true) {
      return fail(
        'connection',
        `Target "${ref.type}" needs a "${provider.connectionType ?? ''}" connection`,
      );
    }

    return provider
      .bind(ref.config, { connections })
      .map((target) => ({ target, connection: undefined }))
      .mapErr((e) => invalidTarget(nested('config', e.issues)));
  }

  if (provider.connectionType === undefined) {
    return fail('connection', `Target "${ref.type}" does not use connections`);
  }
  const connection = connections.get(use.key);
  if (!connection) {
    return fail('connection.key', `No connection named "${use.key}"`);
  }
  if (connection.type !== provider.connectionType) {
    return fail(
      'connection.key',
      `Connection "${use.key}" is a "${connection.type}" connection, but target "${ref.type}" needs "${provider.connectionType}"`,
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
    if (endpoint.target.type !== ref.type) {
      return fail(
        'type',
        `Endpoint "${use.key}/${use.endpoint}" is a "${endpoint.target.type}" target`,
      );
    }
    config =
      ref.config === undefined
        ? endpoint.target.config
        : mergePatch(endpoint.target.config, ref.config);
  }

  return provider
    .bind(config, {
      connection: { key: connection.key, version: connection.version, config: connection.config },
      connections,
    })
    .map((target) => ({
      target,
      connection: { key: connection.key, endpoint: use.endpoint, version: connection.version },
    }))
    .mapErr((e) => invalidTarget(nested('config', e.issues)));
}

const refId = (ref: TargetConnectionRef) => `${ref.key}/${ref.endpoint ?? ''}`;

export function targetConnectionRefs(
  registry: ProviderRegistry,
  ref: TargetRef,
): TargetConnectionRef[] {
  const own = ref.connection ? [ref.connection] : [];
  const children = registry
    .get('target', ref.type)
    .map((provider) => provider.connectionRefs?.(ref.config) ?? [])
    .unwrapOr([]);
  const unique = new Map([...own, ...children].map((r) => [refId(r), r]));

  return [...unique.values()];
}
