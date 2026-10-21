import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { type Connection, connectionCatalog, createConnection } from '../domain/connection.js';
import { newConnectionId, newJobId } from '../domain/ids.js';
import { type JobSpecInput, JobSpec, createJob } from '../domain/job.js';
import { slugKey } from '../domain/slug.js';
import type { TargetResult } from '../domain/target-result.js';
import { mapSecretResolver } from '../shared/secret-resolver.js';
import { extractJobConnection } from './connection-extract.js';
import { resolveTrigger } from './connections.js';
import { ProviderRegistry } from './registry.js';
import {
  type SourceMessage,
  defineConnection,
  defineInlineConnectedEventSource,
  defineInlineConnectedTarget,
  defineTrigger,
  secret,
} from './sdk.js';

const api = defineConnection({
  type: 'api',
  displayName: 'API',
  configSchema: z.object({ baseUrl: z.url(), token: secret(z.string()).optional() }),
});

const poll = defineInlineConnectedEventSource({
  type: 'poll',
  displayName: 'Poll',
  connection: api,
  configSchema: z.object({ ...api.configSchema.partial().shape, feed: z.string() }),
  exclusive: true,
  describe: (config) => `On ${config.feed}`,
  async subscribe(config, { emit, connection }) {
    await emit({
      id: 'm',
      body: `${connection.config.baseUrl}${config.feed} ${connection.config.token ?? ''}`,
      headers: {},
    });
  },
});

const send = defineInlineConnectedTarget({
  type: 'send',
  displayName: 'Send',
  connection: api,
  configSchema: z.object({ ...api.configSchema.partial().shape, path: z.string() }),
  execute: async (): Promise<TargetResult> => ({ outcome: 'success', durationMs: 0 }),
});

const manual = defineTrigger({
  type: 'manual',
  displayName: 'Manual',
  configSchema: z.object({}),
  nextFireAt: () => null,
  describe: () => 'Manual',
});

const registry = new ProviderRegistry().register(api, poll, send, manual);
const now = new Date('2026-01-01T00:00:00Z');

const jobWith = (spec: Partial<JobSpecInput>) =>
  createJob({
    id: newJobId(),
    spec: JobSpec.parse({
      name: 'Ingest orders',
      trigger: { type: 'manual', config: {} },
      target: { type: 'send', config: { baseUrl: 'https://a.example', path: '/x' } },
      ...spec,
    }),
    nextFireAt: null,
    now,
  });

const firstMessage = async (
  ref: Parameters<typeof resolveTrigger>[1],
  connections: readonly Connection[] = [],
) => {
  const { trigger } = resolveTrigger(registry, ref, connectionCatalog(connections))._unsafeUnwrap();
  const messages: SourceMessage[] = [];
  await trigger.source?.subscribe({
    signal: AbortSignal.timeout(1_000),
    secrets: mapSecretResolver({}),
    jobId: 'job',
    emit: (message) => {
      messages.push(message);

      return Promise.resolve();
    },
  });

  return messages[0]?.body;
};

describe('extractJobConnection', () => {
  it('moves an inline event source onto a connection and keeps its jitter', async () => {
    const job = jobWith({
      trigger: {
        type: 'poll',
        jitterMs: 250,
        config: { baseUrl: 'https://feeds.example', token: 't0k', feed: '/orders' },
      },
    });
    const draft = extractJobConnection(registry, job, {
      slot: { kind: 'trigger' },
      key: 'feeds',
      now,
    })._unsafeUnwrap();

    expect(draft.connection).toMatchObject({
      key: 'feeds',
      name: 'Ingest orders',
      type: 'api',
      config: { baseUrl: 'https://feeds.example', token: 't0k' },
      endpoints: [{ key: 'ingest-orders', source: { type: 'poll', config: { feed: '/orders' } } }],
    });
    expect(draft.spec.trigger).toEqual({
      type: 'poll',
      jitterMs: 250,
      connection: { key: 'feeds', endpoint: 'ingest-orders' },
      config: {},
    });

    const before = await firstMessage(job.trigger);
    const after = await firstMessage(draft.spec.trigger, [
      createConnection({ id: newConnectionId(), spec: draft.connection, now }),
    ]);
    expect(after).toBe(before);
  });

  it('uses the requested name and endpoint key', () => {
    const draft = extractJobConnection(registry, jobWith({}), {
      slot: { kind: 'target' },
      key: 'a',
      name: 'Service A',
      endpoint: 'send-x',
      now,
    })._unsafeUnwrap();

    expect(draft.connection.name).toBe('Service A');
    expect(draft.connection.endpoints[0]).toMatchObject({
      key: 'send-x',
      target: { type: 'send' },
    });
    expect(draft.spec.target.connection).toEqual({ key: 'a', endpoint: 'send-x' });
  });

  it('refuses a base URL for non-HTTP connections', () => {
    const error = extractJobConnection(registry, jobWith({}), {
      slot: { kind: 'target' },
      key: 'a',
      baseUrl: 'https://a.example',
      now,
    })._unsafeUnwrapErr();

    expect(error.issues).toEqual([
      { path: 'baseUrl', message: 'Only HTTP connections take a base URL' },
    ]);
  });

  it('reports provider config errors under the slot', () => {
    const error = extractJobConnection(
      registry,
      jobWith({ target: { type: 'send', config: { baseUrl: 'nope', path: '/x' } } }),
      { slot: { kind: 'target' }, key: 'a', now },
    )._unsafeUnwrapErr();

    expect(error.issues[0]?.path).toBe('target.config.baseUrl');
  });

  it('lists providers that can extract', () => {
    const listed = registry.list();
    expect(listed.find((p) => p.type === 'send')?.extractsConnection).toBe(true);
    expect(listed.find((p) => p.type === 'manual')?.extractsConnection).toBe(false);
  });
});

describe('slugKey', () => {
  it.each([
    ['api.stripe.com', 'api-stripe-com'],
    ['Nightly Café export!', 'nightly-cafe-export'],
    ['__', 'fallback'],
    ['x'.repeat(80), 'x'.repeat(63)],
  ])('turns %s into %s', (text, key) => {
    expect(slugKey(text, 'fallback')).toBe(key);
  });
});
