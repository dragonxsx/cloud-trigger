import { z } from 'zod';

import { ConnectionId } from './ids.js';
import { ProviderRef } from './provider-ref.js';

const slug = (what: string) =>
  z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9_-]{0,62}$/,
      `${what} keys use lowercase letters, digits, "-" and "_", at most 63 characters`,
    );

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
    .superRefine((endpoints, ctx) => {
      const seen = new Set<string>();
      endpoints.forEach((endpoint, index) => {
        if (seen.has(endpoint.key)) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'key'],
            message: `Endpoint key "${endpoint.key}" is used twice`,
          });
        }
        seen.add(endpoint.key);
      });
    }),
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
