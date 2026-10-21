import { createServer, type IncomingMessage, type Server } from 'node:http';

import {
  type ExtractSlot,
  type JobSpecInput,
  JobSpec,
  ProviderRegistry,
  type RunLifecycleEvent,
  connectionCatalog,
  createConnection,
  createJob,
  emptyConnectionCatalog,
  extractJobConnection,
  mapSecretResolver,
  newConnectionId,
  newJobId,
  newRunId,
  resolveNotifier,
  resolveTarget,
} from '@cloud-trigger/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { builtinProviders } from '../index.js';
import { testContext } from '../test-helpers.js';
import { splitHttpUrl } from './http.js';

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
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":{}}');
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

const registry = new ProviderRegistry().use(builtinProviders);
const now = new Date('2026-01-01T00:00:05Z');

const jobWith = (spec: Partial<JobSpecInput>) =>
  createJob({
    id: newJobId(),
    spec: JobSpec.parse({
      name: 'Charge customers',
      trigger: { type: 'manual', config: {} },
      target: { type: 'http', config: { url: `${base}/unused` } },
      ...spec,
    }),
    nextFireAt: null,
    now,
  });

const lastRequest = () => {
  const last = seen.at(-1);
  if (!last) {
    throw new Error('nothing received');
  }

  return last;
};

const extract = (job: ReturnType<typeof jobWith>, slot: ExtractSlot, baseUrl?: string) =>
  extractJobConnection(registry, job, { slot, key: 'api', baseUrl, now });

const catalogOf = (draft: ReturnType<typeof extract>) =>
  connectionCatalog([
    createConnection({ id: newConnectionId(), spec: draft._unsafeUnwrap().connection, now }),
  ]);

async function sendTarget(ref: JobSpec['target'], catalog = emptyConnectionCatalog) {
  const { target } = resolveTarget(registry, ref, catalog)._unsafeUnwrap();
  await target.execute({
    payload: { body: '{"hello":1}', contentType: 'application/json', attributes: {} },
    ctx: testContext(),
    signal: AbortSignal.timeout(2_000),
  });

  return lastRequest();
}

const event: RunLifecycleEvent = {
  event: 'failure',
  idempotencyKey: 'notify:run:failure:0',
  jobId: newJobId(),
  jobName: 'Charge customers',
  runId: newRunId(),
  status: 'failed',
  attempt: 1,
  scheduledAt: new Date('2026-01-01T00:00:00Z'),
  lateReasons: [],
  result: null,
  occurredAt: now,
};

async function sendNotifier(
  ref: JobSpec['notifications'][number]['notifier'],
  catalog = emptyConnectionCatalog,
) {
  const { notifier } = resolveNotifier(registry, ref, catalog)._unsafeUnwrap();
  await notifier.notify(event, {
    secrets: mapSecretResolver({ TOKEN: 's3cr3t' }),
    signal: AbortSignal.timeout(2_000),
    now,
  });

  return lastRequest();
}

describe('splitHttpUrl', () => {
  it.each([
    ['https://api.example.com/v1/x?a=1', undefined, 'https://api.example.com', '/v1/x?a=1'],
    ['https://u:p@h.example:8443', undefined, 'https://u:p@h.example:8443', ''],
    ['https://{{secret:HOST}}/x', undefined, 'https://{{secret:HOST}}', '/x'],
    ['https://h/v1/x', 'https://h/v1', 'https://h/v1', '/x'],
    ['https://h/v1/x', 'https://h/v1/', 'https://h/v1/', '/x'],
    ['https://h/v1', 'https://h/v1', 'https://h/v1', ''],
    ['https://h/v1?a=1', 'https://h/v1', 'https://h/v1', '?a=1'],
    ['https://h/v1/{id}/ping', 'https://h/v1', 'https://h/v1', '/{id}/ping'],
    ['https://h/', undefined, 'https://h', '/'],
  ])('splits %s at %s', (url, override, baseUrl, path) => {
    const split = splitHttpUrl(url, override)._unsafeUnwrap();
    expect([split.baseUrl, split.path]).toEqual([baseUrl, path]);
  });

  it.each([
    ['/relative', undefined, 'url'],
    ['{{secret:URL}}', undefined, 'url'],
    ['https://{tenant}.example.com/x', undefined, 'url'],
    ['https://h/x#top', undefined, 'url'],
    ['https://h/v10/x', 'https://h/v1', '@baseUrl'],
    ['https://h/x', 'https://other/', '@baseUrl'],
    ['https://h/x', 'https://h/?a=1', '@baseUrl'],
    ['https://h/v1/{id}/ping', 'https://h/v1/{id}', '@baseUrl'],
    ['https://h/v1/', 'https://h/v1', '@baseUrl'],
    ['https://h/v1//x', 'https://h/v1', '@baseUrl'],
    ['https://h/v1//x', 'https://h/v1/', '@baseUrl'],
    ['https://h/v1//x', 'https://h/v1//', '@baseUrl'],
  ])('refuses %s at %s', (url, override, path) => {
    expect(splitHttpUrl(url, override)._unsafeUnwrapErr()[0]?.path).toBe(path);
  });

  it('warns when the query string would be re-encoded', () => {
    expect(splitHttpUrl('https://h/x?a=x,y')._unsafeUnwrap().warnings).toHaveLength(1);
    expect(splitHttpUrl('https://h/x?a=1&b=2')._unsafeUnwrap().warnings).toEqual([]);
  });
});

describe('extracting a connection', () => {
  it('moves an http target onto a connection and sends the same request', async () => {
    const job = jobWith({
      target: {
        type: 'http',
        config: {
          method: 'PUT',
          url: `${base}/v1/items/{id}?a=1`,
          pathParams: { id: '7' },
          headers: { 'x-team': 'billing', Authorization: 'plain' },
          secretHeaders: { authorization: 'Bearer {{secret:TOKEN}}' },
          query: { b: '2' },
          body: 'payload',
          signing: { secret: '{{secret:TOKEN}}' },
        },
      },
    });
    const draft = extract(job, { kind: 'target' });
    const { connection, spec, endpoint } = draft._unsafeUnwrap();
    expect(connection.config).toEqual({
      baseUrl: base,
      headers: { Authorization: 'plain' },
      secretHeaders: { authorization: 'Bearer {{secret:TOKEN}}' },
      signing: { secret: '{{secret:TOKEN}}' },
    });
    expect(connection.endpoints[0]).toMatchObject({
      key: endpoint,
      target: {
        type: 'http',
        config: { url: '/v1/items/{id}?a=1', headers: { 'x-team': 'billing' } },
      },
    });
    expect(spec.target).toEqual({
      type: 'http',
      connection: { key: 'api', endpoint: 'charge-customers' },
      config: {},
    });

    const before = await sendTarget(job.target);
    const after = await sendTarget(spec.target, catalogOf(draft));
    expect(after).toEqual(before);
    expect(before.url).toBe('/v1/items/7?a=1&b=2');
  });

  it('keeps a base URL prefix on the connection', async () => {
    const job = jobWith({ target: { type: 'http', config: { url: `${base}/v1/ping` } } });
    const draft = extract(job, { kind: 'target' }, `${base}/v1`);
    expect(draft._unsafeUnwrap().connection.config).toEqual({ baseUrl: `${base}/v1` });
    const before = await sendTarget(job.target);
    const after = await sendTarget(draft._unsafeUnwrap().spec.target, catalogOf(draft));
    expect(after).toEqual(before);
  });

  it('moves a graphql target', async () => {
    const job = jobWith({
      target: {
        type: 'graphql',
        config: {
          url: `${base}/graphql`,
          query: '{ ping }',
          secretHeaders: { authorization: 'Bearer {{secret:TOKEN}}' },
        },
      },
    });
    const draft = extract(job, { kind: 'target' });
    const before = await sendTarget(job.target);
    const after = await sendTarget(draft._unsafeUnwrap().spec.target, catalogOf(draft));
    expect(after).toEqual(before);
  });

  it('moves a webhook notifier', async () => {
    const job = jobWith({
      notifications: [
        {
          on: ['failure'],
          notifier: {
            type: 'webhook',
            config: { url: `${base}/hook`, signing: { secret: '{{secret:TOKEN}}' } },
          },
        },
      ],
    });
    const draft = extract(job, { kind: 'notification', index: 0 });
    const notifier = draft._unsafeUnwrap().spec.notifications[0]?.notifier;
    const original = job.notifications[0]?.notifier;
    if (!notifier || !original) {
      throw new Error('missing rule');
    }
    expect(draft._unsafeUnwrap().connection.endpoints[0]).toHaveProperty('notifier');
    const before = await sendNotifier(original);
    const after = await sendNotifier(notifier, catalogOf(draft));
    expect(after).toEqual(before);
  });

  it('refuses a slot that already uses a connection, or a missing rule', () => {
    const job = jobWith({
      target: { type: 'http', connection: { key: 'other' }, config: { url: '/x' } },
    });
    expect(extract(job, { kind: 'target' })._unsafeUnwrapErr().issues[0]?.path).toBe(
      'target.connection',
    );
    expect(
      extract(job, { kind: 'notification', index: 2 })._unsafeUnwrapErr().issues[0]?.path,
    ).toBe('notifications.2');
  });

  it('refuses providers without a connection type', () => {
    expect(extract(jobWith({}), { kind: 'trigger' })._unsafeUnwrapErr().issues[0]?.path).toBe(
      'trigger.type',
    );
  });
});
