import { stringify } from 'safe-stable-stringify';
import { z } from 'zod';

import { ConfigIssue } from '../shared/errors.js';
import { type Endpoint, TargetEndpoint, endpointProvider } from './connection.js';

const KEY_LENGTH = 63;

export const ImportedOperation = z.object({
  operationKey: z
    .string()
    .describe('METHOD and normalized path, such as "GET /pets/{}"; matches existing endpoints.'),
  method: z.string(),
  path: z.string(),
  tags: z.array(z.string()).default([]),
  summary: z.string().default(''),
  deprecated: z.boolean().default(false),
  endpoint: TargetEndpoint.describe('The endpoint this operation becomes when imported.'),
});
export type ImportedOperation = z.output<typeof ImportedOperation>;

export const OpenApiImportOptions = z.object({
  naming: z
    .enum(['operation_id', 'summary', 'method_path'])
    .default('operation_id')
    .describe('What endpoint keys and names are generated from.'),
  bodies: z
    .enum(['none', 'example'])
    .default('none')
    .describe('"example" fills the body from the spec example or a sample of its JSON schema.'),
  includeDeprecated: z.boolean().default(false),
  pathPrefix: z
    .string()
    .max(500)
    .default('')
    .describe("Prepended to every path, when the connection's base URL lacks the server's path."),
});
export type OpenApiImportOptions = z.output<typeof OpenApiImportOptions>;

export const OpenApiAnalysis = z.object({
  info: z.object({ title: z.string(), version: z.string(), openapi: z.string() }),
  servers: z.array(z.string()).describe('Absolute server URLs, variables set to their defaults.'),
  auth: z
    .looseObject({ type: z.string() })
    .optional()
    .describe('Suggested http connection auth from the security schemes, without secrets.'),
  operations: z.array(ImportedOperation),
  warnings: z.array(ConfigIssue),
});
export type OpenApiAnalysis = z.output<typeof OpenApiAnalysis>;

export const ImportMode = z.enum(['skip', 'update', 'keep_both']);
export type ImportMode = z.output<typeof ImportMode>;

export type ImportStatus = 'new' | 'changed' | 'unchanged';

export interface ClassifiedOperation {
  readonly operation: ImportedOperation;
  readonly status: ImportStatus;
  readonly match?: string | undefined;
}

export interface EndpointImportPlan {
  readonly endpoints: readonly Endpoint[];
  readonly added: readonly string[];
  readonly updated: readonly string[];
  readonly unchanged: readonly string[];
  readonly skipped: readonly string[];
}

const StringMap = z.record(z.string(), z.string());
const ConfigRecord = z.record(z.string(), z.unknown());
const HttpRequestFields = z.looseObject({
  method: z.string().default('POST'),
  url: z.string(),
  pathParams: StringMap.default({}),
  query: StringMap.default({}),
  headers: StringMap.default({}),
});

const PLACEHOLDER = /\{([^{}]*)\}/g;

const pathOf = (url: string): string => url.split('?')[0] ?? '';

export const normalizedPath = (url: string): string => {
  const trimmed = pathOf(url).replace(/\/+$/, '').replace(PLACEHOLDER, '{}');

  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
};

const placeholders = (url: string): string[] =>
  [...pathOf(url).matchAll(PLACEHOLDER)].map((match) => match[1] ?? '');

const renamePlaceholders = (url: string, names: readonly string[]): string => {
  const [path = '', ...rest] = url.split('?');
  let index = 0;
  const renamed = path.replace(PLACEHOLDER, (match) => {
    const name = names[index];
    index += 1;

    return name === undefined ? match : `{${name}}`;
  });

  return [renamed, ...rest].join('?');
};

export const operationKey = (method: string, url: string): string =>
  `${method.toUpperCase()} ${normalizedPath(url)}`;

const httpRequestKey = (endpoint: Endpoint): string | undefined => {
  const { kind, ref } = endpointProvider(endpoint);
  if (kind !== 'target' || ref.type !== 'http') {
    return undefined;
  }
  const fields = HttpRequestFields.safeParse(ref.config);

  return fields.success ? operationKey(fields.data.method, fields.data.url) : undefined;
};

export function uniqueEndpointKey(base: string, taken: ReadonlySet<string>): string {
  const root = base.slice(0, KEY_LENGTH);
  let candidate = root;
  for (let n = 2; taken.has(candidate); n += 1) {
    const suffix = `-${n}`;
    candidate = `${root.slice(0, KEY_LENGTH - suffix.length)}${suffix}`;
  }

  return candidate;
}

const requestView = (endpoint: Endpoint): unknown => {
  const { ref } = endpointProvider(endpoint);
  const fields = HttpRequestFields.safeParse(ref.config);

  return {
    name: endpoint.name,
    description: endpoint.description,
    type: ref.type,
    config: fields.success ? fields.data : ref.config,
  };
};

const sameRequest = (a: Endpoint, b: Endpoint): boolean =>
  stringify(requestView(a)) === stringify(requestView(b));

function keepSavedPlaceholderNames(
  saved: { url: string; pathParams: Readonly<Record<string, string>> },
  specUrl: string,
): string[] {
  const savedNames = placeholders(saved.url);
  const specNames = placeholders(specUrl);
  const samePath =
    normalizedPath(saved.url) === normalizedPath(specUrl) && savedNames.length === specNames.length;

  return specNames.map((name, index) =>
    samePath && !Object.hasOwn(saved.pathParams, name) ? (savedNames[index] ?? name) : name,
  );
}

export function mergeImportedEndpoint(existing: Endpoint, incoming: ImportedOperation): Endpoint {
  const { kind, ref } = endpointProvider(existing);
  const current = ConfigRecord.safeParse(ref.config);
  const fields = HttpRequestFields.safeParse(ref.config);
  const spec = HttpRequestFields.safeParse(incoming.endpoint.target.config);
  if (kind !== 'target' || !current.success || !fields.success || !spec.success) {
    return existing;
  }
  const specNames = placeholders(spec.data.url);
  const names = keepSavedPlaceholderNames(fields.data, spec.data.url);
  const nameFor = (name: string): string => names[specNames.indexOf(name)] ?? name;
  const pathParams = Object.fromEntries(
    Object.entries(spec.data.pathParams).map(([name, value]) => [
      nameFor(name),
      fields.data.pathParams[nameFor(name)] ?? value,
    ]),
  );
  const config = {
    ...current.data,
    method: spec.data.method,
    url: renamePlaceholders(spec.data.url, names),
    pathParams,
    query: { ...spec.data.query, ...fields.data.query },
    headers: { ...spec.data.headers, ...fields.data.headers },
  };

  return {
    key: existing.key,
    name: existing.name === '' ? incoming.endpoint.name : existing.name,
    description: existing.description === '' ? incoming.endpoint.description : existing.description,
    target: { ...ref, config },
  };
}

export function classifyOperations(
  existing: readonly Endpoint[],
  operations: readonly ImportedOperation[],
): ClassifiedOperation[] {
  const byRequest = new Map<string, Endpoint>();
  for (const endpoint of existing) {
    const key = httpRequestKey(endpoint);
    if (key !== undefined && !byRequest.has(key)) {
      byRequest.set(key, endpoint);
    }
  }

  return operations.map((operation) => {
    const match = byRequest.get(operation.operationKey);
    if (match === undefined) {
      return { operation, status: 'new' };
    }
    const merged = mergeImportedEndpoint(match, operation);

    return {
      operation,
      status: sameRequest(merged, match) ? 'unchanged' : 'changed',
      match: match.key,
    };
  });
}

export function planEndpointImport(
  existing: readonly Endpoint[],
  selected: readonly ImportedOperation[],
  modeFor: (operation: ImportedOperation) => ImportMode,
): EndpointImportPlan {
  const endpoints = [...existing];
  const taken = new Set(existing.map((endpoint) => endpoint.key));
  const added: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  const skipped: string[] = [];
  const add = (operation: ImportedOperation) => {
    const key = uniqueEndpointKey(operation.endpoint.key, taken);
    taken.add(key);
    endpoints.push({ ...operation.endpoint, key });
    added.push(key);
  };

  for (const { operation, status, match } of classifyOperations(existing, selected)) {
    const index = endpoints.findIndex((endpoint) => endpoint.key === match);
    const current = endpoints[index];
    if (status === 'new' || current === undefined) {
      add(operation);
      continue;
    }
    const mode = modeFor(operation);
    if (mode === 'keep_both') {
      add(operation);
    } else if (mode === 'skip') {
      skipped.push(current.key);
    } else if (status === 'unchanged') {
      unchanged.push(current.key);
    } else {
      endpoints[index] = mergeImportedEndpoint(current, operation);
      updated.push(current.key);
    }
  }

  return { endpoints, added, updated, unchanged, skipped };
}
