import {
  type TestHttpServer,
  describeTargetContract,
  startTestHttpServer,
} from '@cloud-trigger/testing';

import { httpTarget } from './http.js';

let server: TestHttpServer | undefined;
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
