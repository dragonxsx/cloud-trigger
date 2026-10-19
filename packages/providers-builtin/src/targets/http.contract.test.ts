import {
  type TestHttpServer,
  describeTargetContract,
  startTestHttpServer,
} from '@cloud-trigger/testing';

import { httpTarget } from './http.js';

let server: TestHttpServer | undefined;
let connected: TestHttpServer | undefined;
const base = () => server?.url ?? 'http://127.0.0.1:1';

describeTargetContract(httpTarget, {
  setup: async () => {
    server = await startTestHttpServer((req, res) => {
      if (req.url?.startsWith('/slow')) {
        setTimeout(() => res.end('late'), 2_000);
      } else if (req.url?.startsWith('/unavailable')) {
        res.writeHead(503).end();
      } else if (req.url?.startsWith('/missing')) {
        res.writeHead(404).end();
      } else {
        res.end('ok');
      }
    });
  },
  teardown: () => server?.close() ?? Promise.resolve(),
  succeeding: () => ({ url: `${base()}/ok`, secretHeaders: { authorization: 'Bearer x' } }),
  slow: () => ({ url: `${base()}/slow` }),
  retryableFailure: () => ({ url: `${base()}/unavailable` }),
  terminalFailure: () => ({ url: `${base()}/missing` }),
  invalid: { url: 'ftp://example.com' },
  secretPaths: [['secretHeaders', 'authorization']],
  lastTraceparent: () => {
    const header = server?.requests.at(-1)?.headers['traceparent'];

    return Promise.resolve(typeof header === 'string' ? header : undefined);
  },
});

describeTargetContract(httpTarget, {
  setup: async () => {
    connected = await startTestHttpServer((req, res) => {
      if (req.headers.authorization !== 'Bearer contract') {
        res.writeHead(401).end();
      } else if (req.url?.startsWith('/api/slow')) {
        setTimeout(() => res.end('late'), 2_000);
      } else if (req.url?.startsWith('/api/unavailable')) {
        res.writeHead(503).end();
      } else if (req.url?.startsWith('/api/missing')) {
        res.writeHead(404).end();
      } else {
        res.end('ok');
      }
    });
  },
  teardown: () => connected?.close() ?? Promise.resolve(),
  connection: () => ({
    key: 'contract',
    version: 1,
    config: {
      baseUrl: `${connected?.url ?? 'http://127.0.0.1:1'}/api`,
      auth: { type: 'bearer', token: 'contract' },
    },
  }),
  succeeding: () => ({ url: '/ok', secretHeaders: { 'x-extra': 'x' } }),
  slow: () => ({ url: '/slow' }),
  retryableFailure: () => ({ url: '/unavailable' }),
  terminalFailure: () => ({ url: '/missing' }),
  invalid: { url: 'https://elsewhere.test/ok' },
  secretPaths: [['secretHeaders', 'x-extra']],
  lastTraceparent: () => {
    const header = connected?.requests.at(-1)?.headers['traceparent'];

    return Promise.resolve(typeof header === 'string' ? header : undefined);
  },
});
