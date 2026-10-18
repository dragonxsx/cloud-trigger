import { once } from 'node:events';
import { createServer } from 'node:http';
import { Writable } from 'node:stream';

import { pinoHttp } from 'pino-http';
import { describe, expect, it } from 'vitest';

import { createPino } from '../src/infra/logging/logger.js';

describe('createPino', () => {
  it('redacts credentials from pino-http request logs', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString('utf8'));
        done();
      },
    });
    const httpLogger = pinoHttp({ logger: createPino({ level: 'info' }, sink) });
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
      await fetch(`http://127.0.0.1:${port}/api/jobs`, {
        headers: { authorization: 'Bearer top-secret-token', 'x-api-key': 'ct_secret_key' },
      });
    } finally {
      server.close();
    }

    const output = lines.join('');
    expect(output).toContain('request completed');
    expect(output).not.toContain('top-secret-token');
    expect(output).not.toContain('ct_secret_key');
    expect(output).toContain('"authorization":"***"');
  });
});
