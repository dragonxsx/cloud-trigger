import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSpecFetcher, isPublicAddress } from '../src/infra/http/spec-fetcher.js';

let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/spec.yaml' }).end();
    } else if (req.url === '/loop') {
      res.writeHead(302, { location: '/loop' }).end();
    } else if (req.url === '/big') {
      res.end('x'.repeat(2_000));
    } else if (req.url === '/spec.yaml') {
      res.end('openapi: 3.1.0');
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP address');
  }
  port = address.port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const options = { maxBytes: 1_000, timeoutMs: 2_000 };
const guarded = createSpecFetcher({ ...options, allowPrivate: false });
const open = createSpecFetcher({ ...options, allowPrivate: true });
const fetchText = (fetcher: typeof guarded, url: string) =>
  fetcher.fetchText(url, new AbortController().signal);
const message = async (promise: ReturnType<typeof fetchText>) =>
  (await promise)._unsafeUnwrapErr().issues[0]?.message;

describe('spec fetcher', () => {
  it('classifies addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '192.168.0.1',
      '169.254.169.254',
      '::1',
      '::ffff:127.0.0.1',
      'fd00::1',
      '100.64.0.1',
      '0.0.0.0',
    ]) {
      expect({ address, public: isPublicAddress(address) }).toEqual({ address, public: false });
    }
    expect(isPublicAddress('93.184.215.14')).toBe(true);
    expect(isPublicAddress('2606:4700::1111')).toBe(true);
  });

  it('blocks private hosts, by literal IP and by DNS name', async () => {
    const blocked = 'The host resolves to a private or internal address';
    expect(await message(fetchText(guarded, `http://127.0.0.1:${port}/spec.yaml`))).toBe(blocked);
    expect(await message(fetchText(guarded, `http://[::1]:${port}/spec.yaml`))).toBe(blocked);
    expect(await message(fetchText(guarded, `http://localhost:${port}/spec.yaml`))).toBe(blocked);
  });

  it('reports unresolvable hosts as unreachable instead of crashing', async () => {
    expect(await message(fetchText(guarded, 'http://review-test.invalid/spec'))).toBe(
      'The host could not be reached',
    );
  });

  it('fetches private hosts when allowed, following a few redirects', async () => {
    expect((await fetchText(open, `http://127.0.0.1:${port}/redirect`))._unsafeUnwrap()).toEqual({
      text: 'openapi: 3.1.0',
      finalUrl: `http://127.0.0.1:${port}/spec.yaml`,
    });
    expect(await message(fetchText(open, `http://127.0.0.1:${port}/loop`))).toBe(
      'More than 3 redirects',
    );
  });

  it('reports status, size, scheme and URL problems without echoing internals', async () => {
    expect(await message(fetchText(open, `http://127.0.0.1:${port}/missing`))).toBe(
      'The host answered HTTP 404',
    );
    expect(await message(fetchText(open, `http://127.0.0.1:${port}/big`))).toBe(
      'The document is larger than 1000 bytes',
    );
    expect(await message(fetchText(open, 'file:///etc/passwd'))).toBe(
      'Only http and https URLs are supported',
    );
    expect(await message(fetchText(open, 'not a url'))).toBe('Not a valid URL');
  });
});
