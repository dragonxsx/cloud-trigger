import {
  type ConfigError,
  type ConfigIssue,
  type ImportedOperation,
  type OpenApiAnalysis,
  type OpenApiImportOptions,
  type Result,
  assertNever,
  configErrorFromZod,
  err,
  isRecord,
  ok,
  operationKey,
  uniqueEndpointKey,
} from '@cloud-trigger/core';
import { HttpTargetConfig, pathParamNames } from '@cloud-trigger/providers-builtin';
import { upgrade } from '@scalar/openapi-parser';
import { kebabCase } from 'change-case';
import type { JSONSchema7 } from 'json-schema';
import { sample } from 'openapi-sampler';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { type Warn, resolveLocal } from './refs.js';
import {
  HTTP_METHODS,
  type HttpMethod,
  OpenApiDocument,
  Operation,
  Parameter,
  PathItem,
  RequestBody,
  SchemaHints,
  SecurityScheme,
  Server,
  UNSUPPORTED_METHODS,
} from './spec.js';

export const MAX_SPEC_BYTES = 5_000_000;
export const MAX_OPERATIONS = 2_000;
const MAX_WARNINGS = 200;
const KEY_LENGTH = 63;
const SAMPLE_DEPTH = 6;
const SCHEMA_NESTING = SAMPLE_DEPTH * 4;
const MAX_SCHEMA_NODES = 10_000;
const MAX_SAMPLE_BODY = 64_000;
const SAMPLER_SIZE_CAPS = new Map([
  ['minItems', 3],
  ['minLength', 256],
  ['minProperties', 20],
]);
const DATA_KEYWORDS = new Set(['example', 'examples', 'enum', 'const', 'default']);
const IGNORED_HEADERS = new Set(['accept', 'content-type', 'authorization']);
const JSON_MEDIA = /^application\/(?:[\w.-]+\+)?json\b/i;

const SamplerSchema = z.custom<JSONSchema7>(isRecord);

const invalid = (path: string, message: string): ConfigError => ({
  code: 'invalid_config',
  message: 'Invalid OpenAPI document',
  issues: [{ path, message }],
});

const asText = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value === undefined || value === null) {
    return undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
};

const prettyJson = (value: unknown): string | undefined => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
};

function parseText(text: string): Result<unknown, ConfigError> {
  if (text.length > MAX_SPEC_BYTES) {
    return err(invalid('source', `The document is larger than ${MAX_SPEC_BYTES} bytes`));
  }
  try {
    const value: unknown = text.trimStart().startsWith('{')
      ? JSON.parse(text)
      : parseYaml(text, { maxAliasCount: 100 });

    return ok(value);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : 'unreadable';

    return err(invalid('source', `Not valid JSON or YAML: ${reason}`));
  }
}

const versionOf = (raw: Record<string, unknown>): string | undefined => {
  const version = raw['openapi'] ?? raw['swagger'];

  return typeof version === 'string' ? version : undefined;
};

const toKey = (text: string): string =>
  kebabCase(text)
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+/, '')
    .slice(0, KEY_LENGTH)
    .replace(/[-_]+$/, '') || 'endpoint';

const joinPath = (prefix: string, path: string): string => {
  const head = prefix.trim().replace(/\/+$/, '');
  const tail = path.startsWith('/') ? path : `/${path}`;

  return head === '' ? tail : `${head.startsWith('/') ? head : `/${head}`}${tail}`;
};

function serverUrl(server: Server, sourceUrl: string | undefined): string | undefined {
  const url = server.url.replace(
    /\{([^{}]+)\}/g,
    (match, name: string) => asText(server.variables[name]?.default) ?? match,
  );
  try {
    const resolved = new URL(url, sourceUrl);

    return resolved.protocol === 'http:' || resolved.protocol === 'https:'
      ? resolved.toString().replace(/\/+$/, '')
      : undefined;
  } catch {
    return undefined;
  }
}

interface Context {
  readonly root: Record<string, unknown>;
  readonly sourceUrl: string | undefined;
  readonly options: OpenApiImportOptions;
  readonly warn: Warn;
}

function firstExample(ctx: Context, examples: Record<string, unknown> | undefined, at: string) {
  const [first] = Object.values(examples ?? {});
  const example = resolveLocal(ctx.root, first, at, ctx.warn);

  return isRecord(example) ? example['value'] : undefined;
}

function parameterValue(ctx: Context, parameter: Parameter, at: string): string | undefined {
  const hints = SchemaHints.safeParse(resolveLocal(ctx.root, parameter.schema, at, ctx.warn));
  const schema = hints.success ? hints.data : {};

  return asText(
    parameter.example ??
      firstExample(ctx, parameter.examples, at) ??
      schema.example ??
      schema.examples?.[0] ??
      schema.default,
  );
}

function boundedSchema(ctx: Context, raw: unknown, at: string): unknown {
  let budget = MAX_SCHEMA_NODES;
  const copy = (value: unknown, depth: number, refsOnPath: ReadonlySet<string>): unknown => {
    budget -= 1;
    const ref = isRecord(value) ? value['$ref'] : undefined;
    if (typeof ref === 'string' && refsOnPath.has(ref)) {
      const target = resolveLocal(ctx.root, value, at, ctx.warn);
      const type = isRecord(target) ? target['type'] : undefined;

      return typeof type === 'string' ? { type } : {};
    }
    if (budget < 0 || depth > SCHEMA_NESTING) {
      return {};
    }
    if (Array.isArray(value)) {
      return value.map((item) => copy(item, depth + 1, refsOnPath));
    }
    const inner = typeof ref === 'string' ? new Set([...refsOnPath, ref]) : refsOnPath;
    const node = resolveLocal(ctx.root, value, at, ctx.warn) ?? {};
    if (!isRecord(node)) {
      return node;
    }

    return Object.fromEntries(
      Object.entries(node).map(([key, child]) => {
        const limit = SAMPLER_SIZE_CAPS.get(key);
        if (limit !== undefined && typeof child === 'number') {
          return [key, Math.min(child, limit)];
        }

        return [key, DATA_KEYWORDS.has(key) ? child : copy(child, depth + 1, inner)];
      }),
    );
  };
  const bounded = copy(raw, 0, new Set());

  return budget < 0 ? undefined : bounded;
}

function sampleSchema(ctx: Context, raw: unknown, at: string): unknown {
  const bounded = boundedSchema(ctx, raw, at);
  if (bounded === undefined) {
    ctx.warn(at, 'The body schema is too large to sample; no body generated');

    return undefined;
  }
  const schema = SamplerSchema.safeParse(bounded);
  if (!schema.success) {
    return undefined;
  }
  const noExternalRefs = {};
  try {
    return sample(
      schema.data,
      { skipReadOnly: true, maxSampleDepth: SAMPLE_DEPTH, quiet: true },
      noExternalRefs,
    );
  } catch {
    return undefined;
  }
}

function exampleBody(
  ctx: Context,
  raw: unknown,
  at: string,
): { body: string; contentType: string } | undefined {
  const requestBody = RequestBody.safeParse(resolveLocal(ctx.root, raw, at, ctx.warn));
  if (!requestBody.success) {
    return undefined;
  }
  const entries = Object.entries(requestBody.data.content);
  const json = entries.find(([type]) => JSON_MEDIA.test(type));
  if (json === undefined) {
    if (entries.length > 0) {
      ctx.warn(
        at,
        `No body generated for ${entries.map(([type]) => type).join(', ')}; only JSON is`,
      );
    }

    return undefined;
  }
  const [contentType, media] = json;
  const value =
    media.example ?? firstExample(ctx, media.examples, at) ?? sampleSchema(ctx, media.schema, at);
  const body = value === undefined ? undefined : prettyJson(value);
  if (body !== undefined && body.length > MAX_SAMPLE_BODY) {
    ctx.warn(at, `No body generated; the example is longer than ${MAX_SAMPLE_BODY} characters`);

    return undefined;
  }

  return body === undefined ? undefined : { body, contentType };
}

function parametersOf(ctx: Context, lists: readonly (readonly unknown[])[], at: string) {
  const byLocation = new Map<string, Parameter>();
  for (const raw of lists.flat()) {
    const parameter = Parameter.safeParse(resolveLocal(ctx.root, raw, at, ctx.warn));
    if (parameter.success) {
      byLocation.set(`${parameter.data.in}:${parameter.data.name}`, parameter.data);
    }
  }

  return [...byLocation.values()];
}

function requestConfig(
  ctx: Context,
  p: { method: HttpMethod; path: string; operation: Operation; pathParameters: unknown[] },
  at: string,
): Record<string, unknown> {
  const pathParams: Record<string, string> = {};
  const query: Record<string, string> = {};
  const headers: Record<string, string> = {};
  for (const name of pathParamNames(p.path)) {
    pathParams[name] = '';
  }
  for (const parameter of parametersOf(ctx, [p.pathParameters, p.operation.parameters], at)) {
    const value = parameterValue(ctx, parameter, at);
    if (parameter.in === 'path') {
      pathParams[parameter.name] = value ?? '';
    } else if (parameter.in === 'query' && parameter.required) {
      query[parameter.name] = value ?? '';
    } else if (
      parameter.in === 'header' &&
      parameter.required &&
      !IGNORED_HEADERS.has(parameter.name.toLowerCase())
    ) {
      headers[parameter.name] = value ?? '';
    } else if (parameter.in === 'cookie' || parameter.in === 'querystring') {
      ctx.warn(
        at,
        `${parameter.in} parameter "${parameter.name}" is not supported; set it by hand`,
      );
    }
  }
  const body =
    ctx.options.bodies === 'example' && p.operation.requestBody !== undefined
      ? exampleBody(ctx, p.operation.requestBody, at)
      : undefined;
  if (body !== undefined) {
    headers['content-type'] = body.contentType;
  }

  return {
    method: p.method.toUpperCase(),
    url: joinPath(ctx.options.pathPrefix, p.path),
    pathParams,
    query,
    headers,
    ...(body !== undefined && { body: body.body }),
  };
}

function keySource(options: OpenApiImportOptions, operation: Operation, methodPath: string) {
  switch (options.naming) {
    case 'operation_id':
      return operation.operationId ?? methodPath;
    case 'summary':
      return operation.summary ?? operation.operationId ?? methodPath;
    case 'method_path':
      return methodPath;
    default:
      return assertNever(options.naming);
  }
}

type AuthSuggestion = OpenApiAnalysis['auth'];

function mapScheme(scheme: SecurityScheme): AuthSuggestion {
  const httpScheme = scheme.scheme?.toLowerCase();
  if (scheme.type === 'http' && httpScheme === 'bearer') {
    return { type: 'bearer' };
  }
  if (scheme.type === 'http' && httpScheme === 'basic') {
    return { type: 'basic' };
  }
  if (
    scheme.type === 'apiKey' &&
    (scheme.in === 'header' || scheme.in === 'query') &&
    scheme.name !== undefined
  ) {
    return { type: 'api_key', in: scheme.in, name: scheme.name };
  }
  const credentials = scheme.flows?.clientCredentials;
  if (scheme.type === 'oauth2' && credentials !== undefined) {
    const scope = Object.keys(credentials.scopes).join(' ');

    return {
      type: 'oauth2_client_credentials',
      tokenUrl: credentials.tokenUrl,
      ...(scope !== '' && { scope }),
    };
  }

  return undefined;
}

function suggestAuth(ctx: Context, document: OpenApiDocument): AuthSuggestion {
  const schemes = document.components.securitySchemes;
  const names = [
    ...new Set([...document.security.flatMap((r) => Object.keys(r)), ...Object.keys(schemes)]),
  ];
  for (const name of names) {
    const at = `components.securitySchemes.${name}`;
    const scheme = SecurityScheme.safeParse(resolveLocal(ctx.root, schemes[name], at, ctx.warn));
    const auth = scheme.success ? mapScheme(scheme.data) : undefined;
    if (auth !== undefined) {
      return auth;
    }
  }
  if (names.length > 0) {
    ctx.warn(
      'components.securitySchemes',
      `None of ${names.join(', ')} maps to connection auth; configure it by hand`,
    );
  }

  return undefined;
}

function operationsOf(ctx: Context, document: OpenApiDocument, servers: readonly string[]) {
  const operations: ImportedOperation[] = [];
  const taken = new Set<string>();
  const operationIds = new Set<string>();
  for (const [path, rawItem] of Object.entries(document.paths)) {
    const itemAt = `paths.${path}`;
    const resolved = resolveLocal(ctx.root, rawItem, itemAt, ctx.warn);
    if (resolved === undefined) {
      continue;
    }
    const item = PathItem.safeParse(resolved);
    if (!item.success || !isRecord(resolved)) {
      ctx.warn(itemAt, 'Not a valid path item');
      continue;
    }
    for (const method of UNSUPPORTED_METHODS) {
      if (resolved[method] !== undefined) {
        ctx.warn(
          `${itemAt}.${method}`,
          `${method.toUpperCase()} is not supported by the http target`,
        );
      }
    }
    if (item.data.additionalOperations !== undefined) {
      ctx.warn(`${itemAt}.additionalOperations`, 'Custom methods are not supported');
    }
    for (const method of HTTP_METHODS) {
      if (resolved[method] === undefined) {
        continue;
      }
      const at = `${itemAt}.${method}`;
      if (operations.length >= MAX_OPERATIONS) {
        ctx.warn('paths', `Only the first ${MAX_OPERATIONS} operations are listed`);

        return operations;
      }
      const parsed = Operation.safeParse(resolveLocal(ctx.root, resolved[method], at, ctx.warn));
      if (!parsed.success) {
        ctx.warn(at, 'Not a valid operation');
        continue;
      }
      const operation = parsed.data;
      if (operation.deprecated && !ctx.options.includeDeprecated) {
        continue;
      }
      if (operation.operationId !== undefined) {
        if (operationIds.has(operation.operationId)) {
          ctx.warn(at, `operationId "${operation.operationId}" is used twice`);
        }
        operationIds.add(operation.operationId);
      }
      const ownServer = (operation.servers ?? item.data.servers ?? [])
        .map((server) => serverUrl(server, ctx.sourceUrl))
        .find((url) => url !== undefined && !servers.includes(url));
      if (ownServer !== undefined) {
        ctx.warn(at, `Uses its own server ${ownServer}; check the connection's base URL`);
      }
      const config = requestConfig(
        ctx,
        { method, path, operation, pathParameters: item.data.parameters },
        at,
      );
      const valid = HttpTargetConfig.safeParse(config);
      if (!valid.success) {
        ctx.warn(at, `Skipped: ${valid.error.issues.map((issue) => issue.message).join('; ')}`);
        continue;
      }
      const methodPath = `${method.toUpperCase()} ${path}`;
      const key = uniqueEndpointKey(toKey(keySource(ctx.options, operation, methodPath)), taken);
      taken.add(key);
      operations.push({
        operationKey: operationKey(method, valid.data.url),
        method: method.toUpperCase(),
        path,
        tags: operation.tags,
        summary: operation.summary ?? '',
        deprecated: operation.deprecated,
        endpoint: {
          key,
          name: (operation.summary?.trim() || methodPath).slice(0, 200),
          description: (operation.description ?? '').slice(0, 2_000),
          target: { type: 'http', config },
        },
      });
    }
  }

  return operations;
}

export function analyzeOpenApi(
  text: string,
  options: OpenApiImportOptions,
  sourceUrl?: string,
): Result<OpenApiAnalysis, ConfigError> {
  return parseText(text).andThen((raw) => {
    const version = isRecord(raw) ? versionOf(raw) : undefined;
    if (!isRecord(raw) || version === undefined) {
      return err(invalid('source', 'Not an OpenAPI or Swagger document (no "openapi" field)'));
    }
    const upgraded: unknown = (() => {
      try {
        return upgrade(raw).specification;
      } catch {
        return undefined;
      }
    })();
    const parsed = OpenApiDocument.safeParse(upgraded);
    if (!parsed.success || !isRecord(upgraded)) {
      return err(
        parsed.success
          ? invalid('source', `OpenAPI ${version} could not be read`)
          : configErrorFromZod(parsed.error, 'OpenAPI document'),
      );
    }
    const warnings: ConfigIssue[] = [];
    const ctx: Context = {
      root: upgraded,
      sourceUrl,
      options,
      warn: (path, message) => {
        if (warnings.length < MAX_WARNINGS) {
          warnings.push({ path, message });
        }
      },
    };
    const document = parsed.data;
    const servers = document.servers.flatMap((rawServer, index) => {
      const server = Server.safeParse(rawServer);
      const url = server.success ? serverUrl(server.data, sourceUrl) : undefined;
      if (url === undefined) {
        ctx.warn(
          `servers.${index}`,
          server.success
            ? `Server "${server.data.url}" is not an absolute http(s) URL; enter the base URL yourself and use its path as the path prefix`
            : 'Not a valid server',
        );
      }

      return url === undefined ? [] : [url];
    });

    return ok({
      info: { title: document.info.title, version: document.info.version, openapi: version },
      servers,
      ...(() => {
        const auth = suggestAuth(ctx, document);

        return auth === undefined ? {} : { auth };
      })(),
      operations: operationsOf(ctx, document, servers),
      warnings,
    });
  });
}
