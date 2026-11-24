import { once } from 'node:events';
import { createServer } from 'node:http';
import { Writable } from 'node:stream';

import { pinoHttp } from 'pino-http';
import { describe, expect, it } from 'vitest';

import { createPino, redactRequestLog } from '../src/infra/logging/logger.js';

const logRequest = async (path: string, headers: Record<string, string>): Promise<string> => {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString('utf8'));
      done();
    },
  });
  const httpLogger = pinoHttp({
    logger: createPino({ level: 'info' }, sink),
    serializers: { req: redactRequestLog },
  });
  const server = createServer((req, res) => {
    httpLogger(req, res);
    res.end('ok');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP address');
  }
  const { port } = address;
  try {
    await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  } finally {
    server.close();
  }

  return lines.join('');
};

describe('createPino', () => {
  it('redacts credentials from pino-http request logs', async () => {
    const output = await logRequest('/api/jobs', {
      authorization: 'Bearer top-secret-token',
      'x-api-key': 'ct_secret_key',
    });

    expect(output).toContain('request completed');
    expect(output).not.toContain('top-secret-token');
    expect(output).not.toContain('ct_secret_key');
    expect(output).toContain('"authorization":"***"');
  });

  it('redacts the webhook token from the request url', async () => {
    const output = await logRequest('/hooks/01a20734-job/hook-secret-token?x=1', {});

    expect(output).toContain('"url":"/hooks/01a20734-job/***?x=1"');
    expect(output).not.toContain('hook-secret-token');
  });
});

describe('redactRequestLog', () => {
  it('masks the token in route params', () => {
    expect(
      redactRequestLog({
        method: 'POST',
        url: '/hooks/job-1/a%2Bb',
        params: { splat: ['hooks', 'job-1', 'a+b'], token: 'a+b', jobId: 'job-1' },
      }),
    ).toEqual({
      method: 'POST',
      url: '/hooks/job-1/***',
      params: { splat: ['hooks', 'job-1', '***'], token: '***', jobId: 'job-1' },
    });
  });

  it('leaves other requests untouched', () => {
    const req = { method: 'GET', url: '/api/jobs', params: { id: 'x' } };

    expect(redactRequestLog(req)).toBe(req);
  });
});
