import { readFileSync } from 'node:fs';

import { type OpenApiAnalysis, OpenApiImportOptions, isRecord } from '@cloud-trigger/core';
import { describe, expect, it } from 'vitest';

import { analyzeOpenApi } from '../src/index.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const analyze = (name: string, options: Record<string, unknown> = {}, sourceUrl?: string) =>
  analyzeOpenApi(fixture(name), OpenApiImportOptions.parse(options), sourceUrl);

const ok = (name: string, options: Record<string, unknown> = {}): OpenApiAnalysis =>
  analyze(name, options)._unsafeUnwrap();

const configOf = (analysis: OpenApiAnalysis, key: string) =>
  analysis.operations.find((op) => op.endpoint.key === key)?.endpoint.target.config;

const fanOut = (name: string, next: string) => ({
  type: 'object',
  properties: Object.fromEntries(
    Array.from({ length: 30 }, (_, i) => [`p${i}`, { $ref: `#/components/schemas/${next}` }]),
  ),
  required: [],
  [`x-${name}`]: true,
});

describe('analyzeOpenApi', () => {
  it('reads servers, auth and operations from an OpenAPI 3.0 document', () => {
    const analysis = ok('petstore-3.0.json');
    expect(analysis.info).toEqual({
      title: 'Swagger Petstore',
      version: '1.0.0',
      openapi: '3.0.3',
    });
    expect(analysis.servers).toEqual(['https://api.petstore.test/v1']);
    expect(analysis.auth).toEqual({ type: 'bearer' });
    expect(analysis.operations.map((op) => op.endpoint.key)).toEqual([
      'list-pets',
      'create-pet',
      'show-pet-by-id',
      'update-pet',
      'update-pet-2',
      'get-stores-store-id-pets-pet-id',
    ]);
    expect(analysis.operations[2]).toMatchObject({
      operationKey: 'GET /pets/{}',
      tags: ['pets'],
      endpoint: { name: 'Info for a specific pet' },
    });
  });

  it('keeps required query and header parameters with their examples', () => {
    expect(configOf(ok('petstore-3.0.json'), 'list-pets')).toEqual({
      method: 'GET',
      url: '/pets',
      pathParams: {},
      query: { limit: '20' },
      headers: { 'X-Request-Id': 'abc' },
    });
  });

  it('collects path parameters from the template, path item and operation', () => {
    expect(configOf(ok('petstore-3.0.json'), 'get-stores-store-id-pets-pet-id')).toMatchObject({
      pathParams: { storeId: '7', petId: '' },
    });
  });

  it('generates JSON bodies only when asked, from examples or a bounded sample', () => {
    expect(configOf(ok('petstore-3.0.json'), 'create-pet')).not.toHaveProperty('body');
    const analysis = ok('petstore-3.0.json', { bodies: 'example' });
    expect(configOf(analysis, 'create-pet')).toMatchObject({
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rex', parent: {} }, null, 2),
    });
    expect(configOf(analysis, 'update-pet')).toMatchObject({
      body: JSON.stringify({ name: 'Rex II' }, null, 2),
    });
    expect(analysis.warnings).toContainEqual({
      path: 'paths./pets/{petId}.patch',
      message: 'No body generated for multipart/form-data; only JSON is',
    });
  });

  it('caps sample sizes and schema fan-out, including through references', () => {
    const spec = {
      openapi: '3.1.0',
      info: { title: 'Bomb', version: '1' },
      paths: {
        '/big': {
          post: {
            operationId: 'big',
            requestBody: {
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Big' } } },
            },
          },
        },
        '/wide': {
          post: {
            operationId: 'wide',
            requestBody: {
              content: { 'application/json': { schema: { $ref: '#/components/schemas/A' } } },
            },
          },
        },
      },
      components: {
        schemas: {
          Big: {
            type: 'array',
            minItems: 1_000_000,
            items: { type: 'string', minLength: 100_000_000 },
          },
          A: fanOut('a', 'B'),
          B: fanOut('b', 'C'),
          C: fanOut('c', 'D'),
          D: fanOut('d', 'E'),
          E: { type: 'string' },
        },
      },
    };
    const analysis = analyzeOpenApi(
      JSON.stringify(spec),
      OpenApiImportOptions.parse({ bodies: 'example' }),
    )._unsafeUnwrap();
    const big = configOf(analysis, 'big');
    expect(isRecord(big) ? big['body'] : undefined).toMatch(/^\[(?:\n {2}"[^"]{1,256}",?){3}\n\]$/);
    expect(configOf(analysis, 'wide')).not.toHaveProperty('body');
    expect(analysis.warnings).toContainEqual({
      path: 'paths./wide.post',
      message: 'The body schema is too large to sample; no body generated',
    });
  });

  it('skips deprecated operations unless included, and warns about duplicates and cookies', () => {
    const analysis = ok('petstore-3.0.json');
    expect(analysis.operations.some((op) => op.method === 'DELETE')).toBe(false);
    expect(ok('petstore-3.0.json', { includeDeprecated: true }).operations).toContainEqual(
      expect.objectContaining({ method: 'DELETE', deprecated: true }),
    );
    expect(analysis.warnings.map((w) => w.message)).toEqual(
      expect.arrayContaining([
        'cookie parameter "session" is not supported; set it by hand',
        'operationId "updatePet" is used twice',
      ]),
    );
  });

  it('names endpoints by summary or method and path, and applies a path prefix', () => {
    const bySummary = ok('petstore-3.0.json', { naming: 'summary', pathPrefix: 'v1/' });
    expect(bySummary.operations[0]?.endpoint.key).toBe('list-all-pets');
    expect(configOf(bySummary, 'list-all-pets')).toMatchObject({ url: '/v1/pets' });
    expect(bySummary.operations[0]?.operationKey).toBe('GET /v1/pets');
    const byPath = ok('petstore-3.0.json', { naming: 'method_path' });
    expect(byPath.operations[2]?.endpoint.key).toBe('get-pets-pet-id');
  });

  it('upgrades Swagger 2.0 YAML', () => {
    const analysis = ok('petstore-2.0.yaml');
    expect(analysis.info.openapi).toBe('2.0');
    expect(analysis.servers).toEqual(['https://legacy.petstore.test/v2']);
    expect(analysis.auth).toEqual({ type: 'api_key', in: 'header', name: 'X-API-Key' });
    expect(analysis.operations[0]?.endpoint).toMatchObject({
      key: 'get-pet-by-id',
      target: { config: { url: '/pet/{petId}', pathParams: { petId: '' } } },
    });
  });

  it('never follows external references', () => {
    const analysis = ok('external-ref.yaml');
    expect(analysis.operations.map((op) => op.endpoint.key)).toEqual(['remote']);
    expect(analysis.warnings).toEqual([
      expect.objectContaining({ path: 'servers.0' }),
      {
        path: 'paths./secrets',
        message: 'External reference "file:///etc/passwd" is not followed',
      },
      {
        path: 'paths./remote.get',
        message: 'External reference "http://169.254.169.254/latest/meta-data#/x" is not followed',
      },
    ]);
  });

  it('resolves relative servers against the source URL', () => {
    const analysis = analyze('external-ref.yaml', {}, 'https://docs.test/specs/api.yaml');
    expect(analysis._unsafeUnwrap().servers).toEqual(['https://docs.test/api']);
  });

  it('maps OAuth client credentials and warns about OpenAPI 3.2 methods', () => {
    const analysis = ok('methods-3.2.yaml');
    expect(analysis.auth).toEqual({
      type: 'oauth2_client_credentials',
      tokenUrl: 'https://id.test/token',
      scope: 'read write',
    });
    expect(analysis.operations.map((op) => op.endpoint.key)).toEqual(['get-search-results']);
    expect(analysis.warnings.map((w) => w.message)).toEqual([
      'TRACE is not supported by the http target',
      'QUERY is not supported by the http target',
      'Custom methods are not supported',
    ]);
  });

  it('rejects YAML alias bombs, non-OpenAPI input and oversized documents', () => {
    expect(analyze('alias-bomb.yaml')._unsafeUnwrapErr().issues[0]?.message).toMatch(/alias count/);
    const notSpec = analyzeOpenApi('{"hello": 1}', OpenApiImportOptions.parse({}));
    expect(notSpec._unsafeUnwrapErr().issues).toEqual([
      { path: 'source', message: 'Not an OpenAPI or Swagger document (no "openapi" field)' },
    ]);
    const broken = analyzeOpenApi('openapi: [', OpenApiImportOptions.parse({}));
    expect(broken._unsafeUnwrapErr().issues[0]?.message).toMatch(/^Not valid JSON or YAML/);
    const huge = analyzeOpenApi(' '.repeat(5_000_001), OpenApiImportOptions.parse({}));
    expect(huge.isErr()).toBe(true);
  });
});
