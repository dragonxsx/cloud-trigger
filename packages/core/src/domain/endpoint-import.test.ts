import { describe, expect, it } from 'vitest';

import type { Endpoint } from './connection.js';
import {
  type ImportedOperation,
  classifyOperations,
  normalizedPath,
  planEndpointImport,
  uniqueEndpointKey,
} from './endpoint-import.js';

const operation = (
  key: string,
  method: string,
  path: string,
  extra: Record<string, unknown> = {},
): ImportedOperation => ({
  operationKey: `${method} ${normalizedPath(path)}`,
  method,
  path,
  tags: [],
  summary: '',
  deprecated: false,
  endpoint: {
    key,
    name: key,
    description: 'from spec',
    target: { type: 'http', config: { method, url: path, pathParams: {}, query: {}, ...extra } },
  },
});

const getPet = operation('get-pet', 'GET', '/pets/{petId}', { pathParams: { petId: '' } });

const saved = (config: Record<string, unknown>, key = 'pet'): Endpoint => ({
  key,
  name: '',
  description: '',
  target: { type: 'http', config },
});

describe('endpoint import', () => {
  it('normalizes paths so renamed parameters still match', () => {
    expect(normalizedPath('pets/{id}/?x=1')).toBe('/pets/{}');
    const [result] = classifyOperations([saved({ method: 'GET', url: '/pets/{id}' })], [getPet]);
    expect(result).toMatchObject({ status: 'changed', match: 'pet' });
  });

  it('keeps saved placeholder names and their values when the spec renames them', () => {
    const existing = {
      ...saved({ method: 'GET', url: '/pets/{id}', pathParams: { id: '42' } }),
      name: 'get-pet',
      description: 'from spec',
    };
    const plan = planEndpointImport([existing], [getPet], () => 'update');
    expect(plan.unchanged).toEqual(['pet']);
    expect(plan.endpoints[0]).toMatchObject({
      target: { config: { url: '/pets/{id}', pathParams: { id: '42' } } },
    });
  });

  it('treats an endpoint already matching the spec as unchanged, defaults included', () => {
    const imported = planEndpointImport([], [getPet], () => 'update').endpoints;
    const [result] = classifyOperations(imported, [getPet]);
    expect(result?.status).toBe('unchanged');
  });

  it('ignores non-http endpoints and other methods', () => {
    const other: Endpoint = {
      key: 'g',
      name: '',
      description: '',
      target: { type: 'graphql', config: { url: '/pets/{id}' } },
    };
    const post = saved({ method: 'POST', url: '/pets/{id}' });
    expect(classifyOperations([other, post], [getPet]).map((c) => c.status)).toEqual(['new']);
  });

  it('merges updates, keeping user values and adding spec fields', () => {
    const existing = saved({
      method: 'GET',
      url: '/pets/{id}',
      pathParams: { petId: '42', gone: 'x' },
      query: { verbose: '1' },
      headers: { 'x-user': 'me' },
      assertions: { bodyContains: 'ok' },
    });
    const incoming = operation('get-pet', 'GET', '/pets/{petId}', {
      pathParams: { petId: '' },
      query: { limit: '10' },
    });
    const plan = planEndpointImport([existing], [incoming], () => 'update');
    expect(plan.updated).toEqual(['pet']);
    expect(plan.endpoints).toEqual([
      {
        key: 'pet',
        name: 'get-pet',
        description: 'from spec',
        target: {
          type: 'http',
          config: {
            method: 'GET',
            url: '/pets/{petId}',
            pathParams: { petId: '42' },
            query: { limit: '10', verbose: '1' },
            headers: { 'x-user': 'me' },
            assertions: { bodyContains: 'ok' },
          },
        },
      },
    ]);
  });

  it('skips, keeps both with a fresh key, and never removes endpoints', () => {
    const existing = [
      saved({ method: 'GET', url: '/pets/{id}' }, 'get-pet'),
      saved({ url: '/x' }, 'x'),
    ];
    const skip = planEndpointImport(existing, [getPet], () => 'skip');
    expect(skip).toMatchObject({ skipped: ['get-pet'], added: [] });
    expect(skip.endpoints).toEqual(existing);
    const both = planEndpointImport(existing, [getPet], () => 'keep_both');
    expect(both.added).toEqual(['get-pet-2']);
    expect(both.endpoints.map((e) => e.key)).toEqual(['get-pet', 'x', 'get-pet-2']);
  });

  it('keeps generated keys unique and within the slug length', () => {
    const long = 'a'.repeat(63);
    expect(uniqueEndpointKey(long, new Set([long]))).toBe(`${'a'.repeat(61)}-2`);
    expect(uniqueEndpointKey('k', new Set(['k', 'k-2']))).toBe('k-3');
    const plan = planEndpointImport(
      [],
      [operation('same', 'GET', '/a'), operation('same', 'GET', '/b')],
      () => 'update',
    );
    expect(plan.added).toEqual(['same', 'same-2']);
  });
});
