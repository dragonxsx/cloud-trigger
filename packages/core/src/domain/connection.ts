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

export const Endpoint = z.object({
  key: EndpointKey,
  name: z.string().trim().max(200).default(''),
  description: z.string().max(2_000).default(''),
  target: ProviderRef.describe('A complete target config that runs over the connection.'),
});
export type Endpoint = z.output<typeof Endpoint>;

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

export const TargetConnectionRef = z.object({
  key: ConnectionKey,
  endpoint: EndpointKey.optional().describe(
    'Named endpoint of the connection. The target config then only overrides its fields (JSON merge patch).',
  ),
});
export type TargetConnectionRef = z.output<typeof TargetConnectionRef>;

export const TargetRef = ProviderRef.extend({
  connection: TargetConnectionRef.optional().describe(
    'Saved connection that supplies the base address, credentials and defaults.',
  ),
});
export type TargetRef = z.output<typeof TargetRef>;

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
