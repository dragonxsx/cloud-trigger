import { z } from 'zod';

import { assertNever } from '../shared/assert-never.js';
import { mergePatch } from '../shared/merge-patch.js';
import { EnvironmentKey } from './environment.js';
import { ConnectionId } from './ids.js';
import { ProviderRef } from './provider-ref.js';
import { slug } from './slug.js';

export const ConnectionKey = slug('Connection').describe(
  'Stable name jobs use to reference the connection; each deployment defines its own.',
);
export const EndpointKey = slug('Endpoint').describe('Name of the endpoint within its connection.');

const EndpointFields = {
  key: EndpointKey,
  name: z.string().trim().max(200).default(''),
  description: z.string().max(2_000).default(''),
};

export const TargetEndpoint = z
  .strictObject({
    ...EndpointFields,
    target: ProviderRef.describe('A complete target config that runs over the connection.'),
  })
  .meta({ title: 'Target' });

export const SourceEndpoint = z
  .strictObject({
    ...EndpointFields,
    source: ProviderRef.describe(
      'A complete event-source trigger config that consumes over the connection.',
    ),
  })
  .meta({ title: 'Event source' });

export const NotifierEndpoint = z
  .strictObject({
    ...EndpointFields,
    notifier: ProviderRef.describe('A complete notifier config that sends over the connection.'),
  })
  .meta({ title: 'Notifier' });

export const Endpoint = z.union([TargetEndpoint, SourceEndpoint, NotifierEndpoint]);
export type Endpoint = z.output<typeof Endpoint>;

export type EndpointKind = 'target' | 'trigger' | 'notifier';

export const endpointProvider = (
  endpoint: Endpoint,
): { readonly kind: EndpointKind; readonly ref: ProviderRef } => {
  if ('target' in endpoint) {
    return { kind: 'target', ref: endpoint.target };
  }

  return 'source' in endpoint
    ? { kind: 'trigger', ref: endpoint.source }
    : { kind: 'notifier', ref: endpoint.notifier };
};

export const withEndpointProvider = (endpoint: Endpoint, ref: ProviderRef): Endpoint => {
  if ('target' in endpoint) {
    return { ...endpoint, target: ref };
  }

  return 'source' in endpoint ? { ...endpoint, source: ref } : { ...endpoint, notifier: ref };
};

export const newEndpoint = (
  kind: EndpointKind,
  fields: { readonly key: string; readonly name: string; readonly description: string },
  ref: ProviderRef,
): Endpoint => {
  switch (kind) {
    case 'target':
      return { ...fields, target: ref };
    case 'trigger':
      return { ...fields, source: ref };
    case 'notifier':
      return { ...fields, notifier: ref };
    default:
      return assertNever(kind);
  }
};

const uniqueBy =
  <T>(what: string, field: string, keyOf: (item: T) => string) =>
  (items: readonly T[], ctx: z.RefinementCtx) => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      const key = keyOf(item);
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, field],
          message: `${what} "${key}" is used twice`,
        });
      }
      seen.add(key);
    });
  };

export const EndpointOverlay = z.strictObject({
  key: EndpointKey,
  config: z.unknown().describe("JSON merge patch over the endpoint's config in this environment."),
});
export type EndpointOverlay = z.output<typeof EndpointOverlay>;

export const ConnectionOverlay = z.strictObject({
  environment: EnvironmentKey,
  config: z
    .unknown()
    .optional()
    .describe("JSON merge patch over the connection's config in this environment."),
  endpoints: z
    .array(EndpointOverlay)
    .max(200)
    .default([])
    .superRefine(uniqueBy('Endpoint key', 'key', (endpoint: EndpointOverlay) => endpoint.key)),
});
export type ConnectionOverlay = z.output<typeof ConnectionOverlay>;

export const ConnectionSpec = z.object({
  key: ConnectionKey,
  name: z.string().trim().max(200).default(''),
  description: z.string().max(2_000).default(''),
  type: z.string().min(1),
  config: z.unknown(),
  endpoints: z
    .array(Endpoint)
    .max(200)
    .default([])
    .superRefine(uniqueBy('Endpoint key', 'key', (endpoint: Endpoint) => endpoint.key)),
  overlays: z
    .array(ConnectionOverlay)
    .max(50)
    .default([])
    .superRefine(
      uniqueBy('Environment', 'environment', (overlay: ConnectionOverlay) => overlay.environment),
    )
    .describe('Per-environment overrides; an environment without one uses the base config.'),
});
export type ConnectionSpec = z.output<typeof ConnectionSpec>;
export type ConnectionSpecInput = z.input<typeof ConnectionSpec>;

export const Connection = ConnectionSpec.extend({
  id: ConnectionId,
  version: z.int().min(1),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Connection = z.output<typeof Connection>;

export const ConnectionRef = z.object({
  key: ConnectionKey,
  endpoint: EndpointKey.optional().describe(
    'Named endpoint of the connection. The config then only overrides its fields (JSON merge patch).',
  ),
});
export type ConnectionRef = z.output<typeof ConnectionRef>;

const connectedRef = (description: string) =>
  ProviderRef.extend({ connection: ConnectionRef.optional().describe(description) });

export const TargetRef = connectedRef(
  'Saved connection that supplies the base address, credentials and defaults.',
);
export type TargetRef = z.output<typeof TargetRef>;

export const NotifierRef = connectedRef(
  'Saved connection that supplies the address and credentials; an endpoint supplies a saved notifier config.',
);
export type NotifierRef = z.output<typeof NotifierRef>;

export type ConnectionCatalog = ReadonlyMap<string, Connection>;

export const emptyConnectionCatalog: ConnectionCatalog = new Map();

export const connectionCatalog = (connections: Iterable<Connection>): ConnectionCatalog =>
  new Map([...connections].map((connection) => [connection.key, connection]));

export const findEndpoint = (connection: Connection, key: string): Endpoint | undefined =>
  connection.endpoints.find((endpoint) => endpoint.key === key);

export const findOverlay = (
  connection: Pick<Connection, 'overlays'>,
  environment: string | null,
): ConnectionOverlay | undefined =>
  environment === null
    ? undefined
    : connection.overlays.find((overlay) => overlay.environment === environment);

export function overlayConnection(connection: Connection, environment: string | null): Connection {
  const overlay = findOverlay(connection, environment);
  if (!overlay) {
    return connection;
  }
  const patches = new Map(overlay.endpoints.map((endpoint) => [endpoint.key, endpoint.config]));

  return {
    ...connection,
    config:
      overlay.config === undefined
        ? connection.config
        : mergePatch(connection.config, overlay.config),
    endpoints: connection.endpoints.map((endpoint) => {
      const patch = patches.get(endpoint.key);
      if (patch === undefined) {
        return endpoint;
      }
      const { ref } = endpointProvider(endpoint);

      return withEndpointProvider(endpoint, { ...ref, config: mergePatch(ref.config, patch) });
    }),
  };
}

export const inEnvironment = (
  catalog: ConnectionCatalog,
  environment: string | null,
): ConnectionCatalog =>
  environment === null
    ? catalog
    : new Map(
        [...catalog].map(([key, connection]) => [key, overlayConnection(connection, environment)]),
      );

export function createConnection(params: {
  id: ConnectionId;
  spec: ConnectionSpec;
  now: Date;
}): Connection {
  return {
    ...params.spec,
    id: params.id,
    version: 1,
    createdAt: params.now,
    updatedAt: params.now,
  };
}
