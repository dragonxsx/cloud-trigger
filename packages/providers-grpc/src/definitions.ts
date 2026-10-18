import { createHash } from 'node:crypto';

import type { ChannelCredentials } from '@grpc/grpc-js';
import {
  type AnyDefinition,
  type MethodDefinition,
  type Options,
  type PackageDefinition,
  type ServiceDefinition,
  fromJSON,
} from '@grpc/proto-loader';
import { GrpcReflection } from 'grpc-js-reflection-client';
import protobuf from 'protobufjs';

export const LOADER_OPTIONS: Options = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
};

export type UnaryMethod = MethodDefinition<object, object>;

const isService = (definition: AnyDefinition | undefined): definition is ServiceDefinition =>
  definition !== undefined && !('format' in definition);

export const findMethod = (
  definition: PackageDefinition,
  service: string,
  method: string,
): UnaryMethod | string => {
  const candidate = definition[service];
  if (!isService(candidate)) {
    return `Service "${service}" not found`;
  }
  const found = candidate[method];
  if (found === undefined) {
    return `Method "${method}" not found on "${service}"`;
  }
  if (found.requestStream || found.responseStream) {
    return `Method "${service}/${method}" is streaming; only unary calls are supported`;
  }

  return found;
};

const WELL_KNOWN_PREFIX = 'google/protobuf/';

export function parseInlineProto(proto: string): PackageDefinition {
  const parsed = protobuf.parse(proto, { keepCase: true });
  for (const file of parsed.imports ?? []) {
    if (file.startsWith(WELL_KNOWN_PREFIX)) {
      const common = protobuf.common.get(file);
      if (common?.nested) {
        parsed.root.addJSON(common.nested);
      }
    }
  }
  parsed.root.resolveAll();

  return fromJSON(parsed.root.toJSON(), LOADER_OPTIONS);
}

const inlineCache = new Map<string, PackageDefinition>();

export function inlineDefinition(proto: string): PackageDefinition {
  const key = createHash('sha256').update(proto).digest('hex');
  const cached = inlineCache.get(key);
  if (cached) {
    return cached;
  }
  const definition = parseInlineProto(proto);
  inlineCache.set(key, definition);

  return definition;
}

export async function reflectedDefinition(
  address: string,
  credentials: ChannelCredentials,
  service: string,
  deadline: Date,
): Promise<PackageDefinition> {
  const reflection = new GrpcReflection(address, credentials);
  const descriptor = await reflection.getDescriptorBySymbol(service, { deadline });

  return descriptor.getPackageDefinition(LOADER_OPTIONS);
}
