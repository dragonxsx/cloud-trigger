import {
  type Connection,
  ConnectionId,
  ProviderRegistry,
  connectionCatalog,
  mapSecretResolver,
  resolveTarget,
} from '@cloud-trigger/core';
import { type TestHttpServer, startTestHttpServer } from '@cloud-trigger/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { builtinProviders } from '../index.js';
import { createFanoutTarget } from '../targets/fanout.js';
import { testContext } from '../test-helpers.js';
import { clearHttpTokenCache, httpConnection, joinUrl } from './http.js';

const registry = new ProviderRegistry().use(builtinProviders);
registry.register(createFanoutTarget(registry));

let server: TestHttpServer;
let tokensIssued = 0;
let tokenTtlSeconds = 3_600;

beforeAll(async () => {
  server = await startTestHttpServer((req, res) => {
    if (req.url === '/oauth/token') {
      const basic = `Basic ${Buffer.from('app:shh').toString('base64')}`;
      if (
        req.headers.authorization !== basic ||
        !req.body.includes('grant_type=client_credentials')
      ) {
        res
          .writeHead(401, { 'content-type': 'application/json' })
          .end('{"error":"invalid_client"}');

        return;
      }
      tokensIssued++;
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          access_token: `tok-${tokensIssued}`,
          token_type: 'Bearer',
          expires_in: tokenTtlSeconds,
        }),
      );

      return;
    }
    if (req.url?.startsWith('/v2/locked') && req.headers.authorization === undefined) {
      res.writeHead(401).end();

      return;
    }
    if (req.method === 'HEAD' && req.url?.startsWith('/nohead')) {
      res.writeHead(405).end();

      return;
    }
    if (req.url?.startsWith('/v2/graphql')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":{"ok":true}}');

      return;
    }
    res.end('ok');
  });
});
afterAll(() => server.close());
beforeEach(() => {
  clearHttpTokenCache();
  tokensIssued = 0;
  tokenTtlSeconds = 3_600;
});

const connection = (config: Record<string, unknown>, version = 1): Connection => ({
  id: ConnectionId.parse('01890a5d-ac96-774b-bcce-b302099a8057'),
  key: 'api',
  name: '',
  description: '',
  type: 'http',
  config: { baseUrl: `${server.url}/v2`, ...config },
  endpoints: [
    {
      key: 'charge',
      name: '',
      description: '',
      target: { type: 'http', config: { method: 'POST', url: '/charges?mode=live' } },
    },
  ],
  overlays: [],
  version,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

const run = async (
  config: Record<string, unknown>,
  target: { type?: string; config?: unknown; endpoint?: string } = {},
  now = new Date('2026-01-01T00:00:05Z'),
) => {
  const resolved = resolveTarget(
    registry,
    {
      type: target.type ?? 'http',
      connection: {
        key: 'api',
        ...(target.endpoint !== undefined && { endpoint: target.endpoint }),
      },
      config: target.config ?? { url: '/locked' },
    },
    connectionCatalog([connection(config)]),
  )._unsafeUnwrap();

  return resolved.target.execute({
    payload: { body: '{"a":1}', contentType: 'application/json', attributes: {} },
    ctx: testContext({ now }),
    signal: AbortSignal.timeout(2_000),
  });
};

const last = () => server.requests.at(-1);

describe('joinUrl', () => {
  it('appends paths to the base path and merges the query', () => {
    expect(joinUrl('https://x.test/v2', '/charges').href).toBe('https://x.test/v2/charges');
    expect(joinUrl('https://x.test/v2/', 'charges?a=1').href).toBe('https://x.test/v2/charges?a=1');
    expect(joinUrl('https://x.test/v2?k=1', '/c?a=1').href).toBe('https://x.test/v2/c?k=1&a=1');
    expect(joinUrl('https://x.test', '').href).toBe('https://x.test/');
  });
});

describe('http connection', () => {
  it('sends base headers, query and a bearer token, with job headers winning', async () => {
    const result = await run(
      {
        headers: { 'x-env': 'base', 'x-keep': '1' },
        query: { tenant: 't1' },
        auth: { type: 'bearer', token: '{{secret:TOKEN}}' },
      },
      { config: { url: '/locked', headers: { 'x-env': 'job' } } },
    );
    expect(result.outcome).toBe('success');
    expect(last()?.url).toBe('/v2/locked?tenant=t1');
    expect(last()?.headers).toMatchObject({
      authorization: 'Bearer s3cr3t',
      'x-env': 'job',
      'x-keep': '1',
    });
  });

  it('supports basic auth and API keys in a header or the query', async () => {
    await run({ auth: { type: 'basic', username: 'u', password: 'p' } });
    expect(last()?.headers.authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    await run(
      { auth: { type: 'api_key', name: 'X-Api-Key', value: 'k1' } },
      { config: { url: '/open' } },
    );
    expect(last()?.headers['x-api-key']).toBe('k1');
    await run(
      { auth: { type: 'api_key', in: 'query', name: 'key', value: 'k2' } },
      { config: { url: '/open' } },
    );
    expect(last()?.url).toBe('/v2/open?key=k2');
  });

  it('runs a named endpoint with overrides', async () => {
    const result = await run({}, { endpoint: 'charge', config: { query: { dry: '1' } } });
    expect(result.outcome).toBe('success');
    expect(last()).toMatchObject({
      method: 'POST',
      url: '/v2/charges?mode=live&dry=1',
      body: '{"a":1}',
    });
  });

  it('fetches, caches and refreshes OAuth client-credentials tokens', async () => {
    const auth = {
      type: 'oauth2_client_credentials',
      tokenUrl: `${server.url}/oauth/token`,
      clientId: 'app',
      clientSecret: 'shh',
      scope: 'jobs',
    };
    tokenTtlSeconds = 60;
    const t0 = new Date('2026-01-01T00:00:00Z');
    expect((await run({ auth }, {}, t0)).outcome).toBe('success');
    expect(last()?.headers.authorization).toBe('Bearer tok-1');
    await run({ auth }, {}, new Date(t0.getTime() + 10_000));
    expect(tokensIssued).toBe(1);
    await run({ auth }, {}, new Date(t0.getTime() + 45_000));
    expect(tokensIssued).toBe(2);
    expect(last()?.headers.authorization).toBe('Bearer tok-2');

    const rejected = await run({ auth: { ...auth, clientSecret: 'wrong' } }, {}, t0);
    expect(rejected.error).toMatchObject({ code: 'auth_failed', retryable: false });
  });

  it('caches OAuth tokens per audience and scope under the same connection version', async () => {
    const auth = {
      type: 'oauth2_client_credentials',
      tokenUrl: `${server.url}/oauth/token`,
      clientId: 'app',
      clientSecret: 'shh',
      audience: 'prod',
    };
    await run({ auth });
    await run({ auth: { ...auth, audience: 'staging' } });
    expect(tokensIssued).toBe(2);
    expect(last()?.headers.authorization).toBe('Bearer tok-2');
    await run({ auth: { ...auth, scope: 'jobs' } });
    expect(tokensIssued).toBe(3);
    await run({ auth });
    expect(tokensIssued).toBe(3);
  });

  it('reports a missing secret before calling anything', async () => {
    const before = server.requests.length;
    const result = await run({ auth: { type: 'bearer', token: '{{secret:NOPE}}' } });
    expect(result.error).toMatchObject({ code: 'missing_secret', retryable: false });
    expect(server.requests.length).toBe(before);
  });

  it('requires a relative URL over a connection and an absolute one without', () => {
    const catalog = connectionCatalog([connection({})]);
    const issues = (ref: Parameters<typeof resolveTarget>[1]) => {
      const resolved = resolveTarget(registry, ref, catalog);

      return resolved.isErr() ? resolved.error.issues.map((i) => i.path) : [];
    };
    expect(
      issues({ type: 'http', connection: { key: 'api' }, config: { url: 'https://evil.test/x' } }),
    ).toEqual(['config.url']);
    expect(
      issues({ type: 'http', connection: { key: 'api' }, config: { url: '//evil.test/x' } }),
    ).toEqual(['config.url']);
    expect(issues({ type: 'http', config: { url: '/x' } })).toEqual(['config.url']);
    expect(
      issues({ type: 'graphql', connection: { key: 'api' }, config: { query: '{ ok }' } }),
    ).toEqual([]);
  });

  it('runs graphql and fan-out children over the connection', async () => {
    const graphql = await run(
      {},
      { type: 'graphql', config: { url: '/graphql', query: '{ ok }' } },
    );
    expect(graphql.outcome).toBe('success');
    const fanout = resolveTarget(
      registry,
      {
        type: 'fanout',
        config: {
          targets: [
            { type: 'http', connection: { key: 'api', endpoint: 'charge' }, config: {} },
            { type: 'http', connection: { key: 'api' }, config: { url: '/open' } },
          ],
        },
      },
      connectionCatalog([connection({})]),
    )._unsafeUnwrap();
    const result = await fanout.target.execute({
      payload: { body: undefined, contentType: undefined, attributes: {} },
      ctx: testContext(),
      signal: AbortSignal.timeout(2_000),
    });
    expect(result.outcome).toBe('success');
    expect(
      server.requests
        .slice(-2)
        .map((r) => r.url ?? '')
        .toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(['/v2/charges?mode=live', '/v2/open']);
    const missing = resolveTarget(
      registry,
      {
        type: 'fanout',
        config: { targets: [{ type: 'http', connection: { key: 'nope' }, config: {} }] },
      },
      connectionCatalog([]),
    );
    expect(missing._unsafeUnwrapErr().issues.map((i) => i.path)).toEqual([
      'config.targets.0.connection.key',
    ]);
  });

  it('tests reachability and credentials', async () => {
    const ctx = {
      secrets: mapSecretResolver({}),
      signal: AbortSignal.timeout(2_000),
      now: new Date(),
    };
    const test = (config: Record<string, unknown>) =>
      httpConnection
        .bind({ baseUrl: server.url, ...config })
        ._unsafeUnwrap()
        .test(ctx);
    expect((await test({}))._unsafeUnwrap().message).toMatch(/HTTP 200/);
    expect((await test({ baseUrl: `${server.url}/nohead` }))._unsafeUnwrap().message).toMatch(
      /HTTP 200/,
    );
    expect((await test({ baseUrl: `${server.url}/v2/locked` }))._unsafeUnwrapErr().message).toMatch(
      /rejected/,
    );
    expect((await test({ baseUrl: 'http://127.0.0.1:1' }))._unsafeUnwrapErr().message).toMatch(
      /ECONNREFUSED/,
    );
  });
});
