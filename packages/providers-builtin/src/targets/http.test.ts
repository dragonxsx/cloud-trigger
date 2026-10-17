import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { testContext } from '../test-helpers.js';
import { httpTarget } from './http.js';

let server: Server;
let base = '';
const seen: { headers: IncomingMessage['headers']; body: string; url: string | undefined }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => {
      body += c.toString();
    });
    req.on('end', () => {
      seen.push({ headers: req.headers, body, url: req.url });
      const path = req.url ?? '/';
      if (path.startsWith('/slow')) {
        setTimeout(() => res.end('late'), 500);
      } else if (path.startsWith('/redirect')) {
        res.writeHead(302, { location: '/ok' }).end();
      } else if (path.startsWith('/fail')) {
        res.writeHead(503).end('down');
      } else if (path.startsWith('/big')) {
        res.end('x'.repeat(5_000));
      } else {
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end('{"status":"ok","items":[1,2]}');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP address');
  }
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const run = (config: Record<string, unknown>, timeoutMs = 2_000) =>
  httpTarget
    .bind(config)
    ._unsafeUnwrap()
    .execute({
      payload: {
        body: '{"hello":1}',
        contentType: 'application/json',
        attributes: { 'x-extra': '1' },
      },
      ctx: testContext(),
      signal: AbortSignal.timeout(timeoutMs),
    });

describe('http target', () => {
  it('sends payload, secrets in headers, signature and passes JSONPath assertion', async () => {
    const result = await run({
      url: `${base}/ok`,
      headers: { authorization: 'Bearer {{secret:TOKEN}}' },
      query: { a: 'b' },
      signing: { secret: 'k' },
      assertions: { jsonPath: { path: '$.status', equals: 'ok' } },
    });
    expect(result.outcome).toBe('success');
    expect(result.statusCode).toBe(200);
    const last = seen.at(-1);
    expect(last?.url).toBe('/ok?a=b');
    expect(last?.body).toBe('{"hello":1}');
    expect(last?.headers['authorization']).toBe('Bearer s3cr3t');
    expect(last?.headers['x-extra']).toBe('1');
    expect(last?.headers['x-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('resolves secret placeholders in the signing key', async () => {
    const result = await run({ url: `${base}/ok`, signing: { secret: '{{secret:TOKEN}}' } });
    expect(result.outcome).toBe('success');
    const last = seen.at(-1);
    const timestamp = last?.headers['x-signature-timestamp'];
    expect(typeof timestamp).toBe('string');
    const expected = createHmac('sha256', 's3cr3t')
      .update(`${String(timestamp)}.{"hello":1}`)
      .digest('hex');
    expect(last?.headers['x-signature']).toBe(`sha256=${expected}`);

    const missing = await run({ url: `${base}/ok`, signing: { secret: '{{secret:NOPE}}' } });
    expect(missing.error?.code).toBe('missing_secret');
  });

  it('signs the empty body a GET actually sends', async () => {
    const result = await run({ method: 'GET', url: `${base}/ok`, signing: { secret: 'k' } });
    expect(result.outcome).toBe('success');
    const last = seen.at(-1);
    expect(last?.body).toBe('');
    expect(last?.headers['content-type']).toBeUndefined();
    const timestamp = String(last?.headers['x-signature-timestamp']);
    const expected = createHmac('sha256', 'k').update(`${timestamp}.`).digest('hex');
    expect(last?.headers['x-signature']).toBe(`sha256=${expected}`);
  });

  it('sends secret headers with placeholders resolved', async () => {
    const result = await run({
      url: `${base}/ok`,
      secretHeaders: { authorization: 'Bearer {{secret:TOKEN}}' },
    });
    expect(result.outcome).toBe('success');
    expect(seen.at(-1)?.headers['authorization']).toBe('Bearer s3cr3t');
  });

  it('follows redirects, truncates big bodies', async () => {
    expect((await run({ method: 'GET', url: `${base}/redirect` })).statusCode).toBe(200);
    const big = await run({ method: 'GET', url: `${base}/big`, maxResponseBytes: 100 });
    expect(big.response).toMatchObject({ sizeBytes: 5_000, truncated: true });
    expect(big.response?.body).toHaveLength(100);
  });

  it('marks 5xx as retryable failure and assertion mismatch as failure', async () => {
    const down = await run({ url: `${base}/fail` });
    expect(down).toMatchObject({ outcome: 'failure', statusCode: 503, error: { retryable: true } });
    const mismatch = await run({ url: `${base}/ok`, assertions: { bodyContains: 'nope' } });
    expect(mismatch).toMatchObject({
      outcome: 'failure',
      error: { code: 'http_assertion', retryable: false },
    });
  });

  it('rejects malformed retryOnStatus patterns', () => {
    expect(httpTarget.bind({ url: base, retryOnStatus: ['abc'] }).isErr()).toBe(true);
    expect(httpTarget.bind({ url: base, retryOnStatus: ['5xx', '418', '500-504'] }).isOk()).toBe(
      true,
    );
  });

  it('reports timeouts and missing secrets', async () => {
    expect((await run({ url: `${base}/slow` }, 100)).error?.code).toBe('timeout');
    expect((await run({ url: `${base}/ok`, headers: { a: '{{secret:NOPE}}' } })).error?.code).toBe(
      'missing_secret',
    );
  });
});
