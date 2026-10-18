import { ProviderRegistry, REDACTED, redactBySchema } from '@cloud-trigger/core';
import {
  type TestHttpServer,
  describeTargetContract,
  startTestHttpServer,
} from '@cloud-trigger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { builtinProviders } from '../index.js';
import { testContext } from '../test-helpers.js';
import { createFanoutTarget } from './fanout.js';

const registry = new ProviderRegistry().use(builtinProviders);
const fanout = createFanoutTarget(registry);
registry.register(fanout);

let server: TestHttpServer | undefined;
const url = (path: string) => `${server?.url ?? 'http://127.0.0.1:1'}${path}`;
const http = (path: string, extra: Record<string, unknown> = {}) => ({
  type: 'http',
  config: { url: url(path), ...extra },
});

const start = async () => {
  server = await startTestHttpServer((req, res) => {
    if (req.url?.startsWith('/slow')) {
      setTimeout(() => res.end(), 2_000).unref();
    } else if (req.url?.startsWith('/down')) {
      res.writeHead(503).end();
    } else if (req.url?.startsWith('/missing')) {
      res.writeHead(404).end();
    } else {
      res.end('ok');
    }
  });
};
const stop = () => server?.close() ?? Promise.resolve();

describeTargetContract(fanout, {
  setup: start,
  teardown: stop,
  succeeding: () => ({
    targets: [http('/a'), http('/b', { secretHeaders: { authorization: 'x' } })],
  }),
  slow: () => ({ targets: [http('/a'), http('/slow')] }),
  retryableFailure: () => ({ targets: [http('/a'), http('/down')] }),
  terminalFailure: () => ({ targets: [http('/down'), http('/missing')] }),
  invalid: { targets: [] },
  secretPaths: [['targets', '1', 'config', 'secretHeaders', 'authorization']],
});

const run = (config: Record<string, unknown>) =>
  fanout
    .bind(config)
    ._unsafeUnwrap()
    .execute({
      payload: { body: '{"n":1}', contentType: 'application/json', attributes: {} },
      ctx: testContext({ idempotencyKey: 'manual:job:1' }),
      signal: AbortSignal.timeout(5_000),
    });

describe('fan-out target', () => {
  beforeAll(start);
  afterAll(stop);

  it('sends the payload to every child and records each result', async () => {
    const result = await run({
      targets: [{ ...http('/one'), name: 'Primary' }, http('/two')],
      parallelism: 1,
    });
    expect(result.outcome).toBe('success');
    expect(result.metadata).toMatchObject({
      mode: 'all',
      children: [
        { index: 0, name: 'Primary', type: 'http', outcome: 'success', statusCode: 200 },
        { index: 1, type: 'http', outcome: 'success', statusCode: 200 },
      ],
    });
    const bodies = server?.requests.filter((r) => r.url === '/one' || r.url === '/two');
    expect(bodies?.map((r) => r.body)).toEqual(['{"n":1}', '{"n":1}']);
  });

  it('succeeds in any mode when one child succeeds', async () => {
    const result = await run({ targets: [http('/down'), http('/ok')], mode: 'any' });
    expect(result.outcome).toBe('success');
    const failed = await run({ targets: [http('/down'), http('/missing')], mode: 'any' });
    expect(failed.error).toMatchObject({ code: 'fanout_failed', retryable: false });
    expect(failed.error?.message).toMatch(/^2 of 2 targets failed/);
  });

  it('reports child config issues under their path and rejects nesting', () => {
    const invalid = fanout.bind({
      targets: [
        { type: 'http', config: { url: 'ftp://x' } },
        { type: 'fanout', config: {} },
      ],
    });
    const paths = invalid.isErr() ? invalid.error.issues.map((issue) => issue.path) : [];
    expect(paths).toEqual(['targets.0.config.url', 'targets.1.type']);
  });

  it('exposes each child schema so forms render and nested secrets redact', () => {
    const schema = fanout.jsonSchema();
    const items = schema.properties?.['targets'];
    const branches =
      typeof items === 'object' && typeof items.items === 'object' && !Array.isArray(items.items)
        ? (items.items.anyOf ?? [])
        : [];
    const types = branches.flatMap((branch) =>
      typeof branch === 'object' && typeof branch.properties?.['type'] === 'object'
        ? [branch.properties['type'].const]
        : [],
    );
    expect(types).toContain('http');
    expect(types).toContain('graphql');
    expect(types).not.toContain('fanout');
    expect(
      redactBySchema(schema, {
        targets: [{ type: 'http', config: { url: 'http://x', secretHeaders: { a: 'b' } } }],
      }),
    ).toMatchObject({ targets: [{ config: { secretHeaders: { a: REDACTED } } }] });
  });
});
