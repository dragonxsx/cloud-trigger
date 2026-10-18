import type { ServerResponse } from 'node:http';

import {
  type RecordedRequest,
  type TestHttpServer,
  describeTargetContract,
  startTestHttpServer,
} from '@cloud-trigger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { testContext } from '../test-helpers.js';
import { graphqlTarget } from './graphql.js';

const QUERY = 'query Hello($name: String) { hello(name: $name) }';

const json = (res: ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

const handler = (req: RecordedRequest, res: ServerResponse) => {
  const path = req.url ?? '/';
  if (path.startsWith('/slow')) {
    setTimeout(() => json(res, 200, { data: { hello: 'late' } }), 2_000);
  } else if (path.startsWith('/unavailable')) {
    json(res, 503, {});
  } else if (path.startsWith('/errors')) {
    json(res, 200, { data: null, errors: [{ message: 'Boom', extensions: { code: 'INTERNAL' } }] });
  } else if (path.startsWith('/limited')) {
    json(res, 200, { errors: [{ message: 'Slow down', extensions: { code: 'RATE_LIMITED' } }] });
  } else if (path.startsWith('/partial')) {
    json(res, 200, { data: { hello: 'partly' }, errors: [{ message: 'Field failed' }] });
  } else if (path.startsWith('/html')) {
    res.writeHead(200, { 'content-type': 'text/html' }).end('<html></html>');
  } else {
    json(res, 200, { data: { hello: 'world' } });
  }
};

let server: TestHttpServer | undefined;
const url = (path: string) => `${server?.url ?? 'http://127.0.0.1:1'}${path}`;

describeTargetContract(graphqlTarget, {
  setup: async () => {
    server = await startTestHttpServer(handler);
  },
  teardown: () => server?.close() ?? Promise.resolve(),
  succeeding: () => ({ url: url('/ok'), query: QUERY, secretHeaders: { authorization: 'x' } }),
  slow: () => ({ url: url('/slow'), query: QUERY }),
  retryableFailure: () => ({ url: url('/unavailable'), query: QUERY }),
  terminalFailure: () => ({ url: url('/errors'), query: QUERY }),
  invalid: { url: 'http://x', query: 'query {' },
  secretPaths: [['secretHeaders', 'authorization']],
  lastTraceparent: () => {
    const header = server?.requests.at(-1)?.headers['traceparent'];

    return Promise.resolve(typeof header === 'string' ? header : undefined);
  },
});

const run = (config: Record<string, unknown>, body = '{"name":"payload"}') => {
  const bound = graphqlTarget.bind(config);
  if (bound.isErr()) {
    throw new Error(bound.error.message);
  }

  return bound.value.execute({
    payload: { body, contentType: 'application/json', attributes: {} },
    ctx: testContext(),
    signal: AbortSignal.timeout(2_000),
  });
};

describe('graphql target', () => {
  beforeAll(async () => {
    server = await startTestHttpServer(handler);
  });
  afterAll(() => server?.close() ?? Promise.resolve());

  it('posts query, operationName and payload variables as JSON', async () => {
    const result = await run({
      url: url('/ok'),
      query: QUERY,
      operationName: 'Hello',
      headers: { authorization: 'Bearer {{secret:TOKEN}}' },
    });
    expect(result.outcome).toBe('success');
    const sent = server?.requests.at(-1);
    expect(sent?.method).toBe('POST');
    expect(sent?.headers['content-type']).toBe('application/json');
    expect(sent?.headers['authorization']).toBe('Bearer s3cr3t');
    expect(JSON.parse(sent?.body ?? '')).toEqual({
      query: QUERY,
      operationName: 'Hello',
      variables: { name: 'payload' },
    });
  });

  it('renders configured variables from a Liquid template', async () => {
    await run({ url: url('/ok'), query: QUERY, variables: '{"name":"{{ run.jobName }}"}' });
    expect(JSON.parse(server?.requests.at(-1)?.body ?? '')).toMatchObject({
      variables: { name: 'Test job' },
    });
  });

  it('rejects a query with a syntax error per field', () => {
    const bound = graphqlTarget.bind({ url: 'http://x', query: '{ hello(' });
    expect(bound.isErr() && bound.error.issues[0]?.path).toBe('query');
  });

  it('fails with graphql_error and keeps the errors in metadata', async () => {
    const result = await run({ url: url('/errors'), query: QUERY });
    expect(result.error).toMatchObject({
      code: 'graphql_error',
      message: 'Boom',
      retryable: false,
    });
    expect(result.metadata).toMatchObject({ errors: [{ message: 'Boom' }] });
  });

  it('retries only listed error codes', async () => {
    const result = await run({
      url: url('/limited'),
      query: QUERY,
      retryOnErrorCodes: ['RATE_LIMITED'],
    });
    expect(result.error).toMatchObject({ code: 'graphql_error', retryable: true });
  });

  it('accepts partial data only when allowPartial is set', async () => {
    const strict = await run({ url: url('/partial'), query: QUERY });
    expect(strict.outcome).toBe('failure');
    const lenient = await run({ url: url('/partial'), query: QUERY, allowPartial: true });
    expect(lenient.outcome).toBe('success');
    expect(lenient.metadata).toMatchObject({ errors: [{ message: 'Field failed' }] });
  });

  it('runs JSONPath assertions against the whole response', async () => {
    const result = await run({
      url: url('/ok'),
      query: QUERY,
      assertions: { jsonPath: { path: '$.data.hello', equals: 'nope' } },
    });
    expect(result.error).toMatchObject({ code: 'http_assertion', retryable: false });
  });

  it('rejects non-object variables and non-GraphQL responses', async () => {
    const badVariables = await run({ url: url('/ok'), query: QUERY }, '[1]');
    expect(badVariables.error).toMatchObject({ code: 'invalid_variables', retryable: false });
    const html = await run({ url: url('/html'), query: QUERY });
    expect(html.error).toMatchObject({ code: 'invalid_response' });
  });
});
