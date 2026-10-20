import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  type Connection,
  ConnectionSpec,
  connectionCatalog,
  emptyConnectionCatalog,
  inEnvironment,
  overlayConnection,
} from '../domain/connection.js';
import { ConnectionId } from '../domain/ids.js';
import type { TargetResult } from '../domain/target-result.js';
import { mapSecretResolver } from '../shared/secret-resolver.js';
import {
  jobConnectionRefs,
  resolveTarget,
  resolveTrigger,
  targetConnectionRefs,
} from './connections.js';
import { ProviderRegistry } from './registry.js';
import {
  type SourceMessage,
  type TargetRequest,
  defineConnectedTarget,
  defineConnection,
  defineInlineConnectedEventSource,
  defineInlineConnectedTarget,
  defineTarget,
  defineTrigger,
  secret,
} from './sdk.js';

const api = defineConnection({
  type: 'api',
  displayName: 'API',
  configSchema: z.object({ baseUrl: z.url(), token: secret(z.string()).optional() }),
});

const call = defineConnectedTarget({
  type: 'call',
  displayName: 'Call',
  connection: api,
  configSchema: z.object({
    method: z.enum(['GET', 'POST']).default('GET'),
    path: z.string(),
    headers: z.record(z.string(), z.string()).default({}),
  }),
  check: (config, connection) =>
    connection === undefined && !config.path.startsWith('http')
      ? [{ path: 'path', message: 'Needs an absolute URL without a connection' }]
      : [],
  execute: async (config, { connection }): Promise<TargetResult> => ({
    outcome: 'success',
    durationMs: 0,
    metadata: {
      url: `${connection?.config.baseUrl ?? ''}${config.path}`,
      method: config.method,
      headers: config.headers,
      connection: connection ? `${connection.key}@${connection.version}` : null,
    },
  }),
});

const plain = defineTarget({
  type: 'plain',
  displayName: 'Plain',
  configSchema: z.object({}),
  execute: async (): Promise<TargetResult> => ({ outcome: 'success', durationMs: 0 }),
});

const poll = defineInlineConnectedEventSource({
  type: 'poll',
  displayName: 'Poll',
  connection: api,
  configSchema: z.object({
    ...api.configSchema.partial().shape,
    feed: z.string(),
    batch: z.int().default(10),
  }),
  exclusive: true,
  describe: (config) => `On ${config.feed}`,
  async subscribe(config, { emit, connection }) {
    await emit({
      id: `${connection.key}@${connection.version}`,
      body: `${connection.config.baseUrl}${config.feed}?batch=${config.batch}`,
      headers: {},
    });
  },
});

const tick = defineTrigger({
  type: 'tick',
  displayName: 'Tick',
  configSchema: z.object({}),
  nextFireAt: () => null,
  describe: () => 'Never',
});

const registry = new ProviderRegistry().register(api, call, plain, poll, tick);

const billing: Connection = {
  id: ConnectionId.parse('01890a5d-ac96-774b-bcce-b302099a8057'),
  key: 'billing',
  name: 'Billing',
  description: '',
  type: 'api',
  config: { baseUrl: 'https://billing.test/v1' },
  endpoints: [
    {
      key: 'charge',
      name: '',
      description: '',
      target: {
        type: 'call',
        config: { method: 'POST', path: '/charges', headers: { a: '1', b: '2' } },
      },
    },
    {
      key: 'invoices',
      name: '',
      description: '',
      source: { type: 'poll', config: { feed: '/invoices', batch: 5 } },
    },
  ],
  overlays: [
    {
      environment: 'staging',
      config: { baseUrl: 'https://staging.billing.test/v1' },
      endpoints: [{ key: 'charge', config: { headers: { a: null, s: 'yes' } } }],
    },
  ],
  version: 3,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
const catalog = connectionCatalog([billing]);

const request: TargetRequest = {
  payload: { body: undefined, contentType: undefined, attributes: {} },
  signal: AbortSignal.timeout(1_000),
  ctx: {
    runId: 'r',
    jobId: 'j',
    jobName: 'n',
    attempt: 1,
    scheduledAt: new Date(0),
    reason: 'manual',
    now: new Date(0),
    secrets: mapSecretResolver({}),
  },
};

const issuesOf = (result: ReturnType<typeof resolveTarget>) =>
  result.isErr() ? result.error.issues : [];

describe('resolveTarget', () => {
  it('runs an endpoint with the job config as a merge patch', async () => {
    const resolved = resolveTarget(
      registry,
      {
        type: 'call',
        connection: { key: 'billing', endpoint: 'charge' },
        config: { headers: { b: null, c: '3' } },
      },
      catalog,
    )._unsafeUnwrap();
    expect(resolved.connection).toEqual({ key: 'billing', endpoint: 'charge', version: 3 });
    const result = await resolved.target.execute(request);
    expect(result.metadata).toEqual({
      url: 'https://billing.test/v1/charges',
      method: 'POST',
      headers: { a: '1', c: '3' },
      connection: 'billing@3',
    });
  });

  it('runs a full config over a connection without an endpoint', async () => {
    const resolved = resolveTarget(
      registry,
      { type: 'call', connection: { key: 'billing' }, config: { path: '/health' } },
      catalog,
    )._unsafeUnwrap();
    expect((await resolved.target.execute(request)).metadata).toMatchObject({
      url: 'https://billing.test/v1/health',
      method: 'GET',
    });
  });

  it('keeps inline targets working without a connection', () => {
    expect(
      resolveTarget(
        registry,
        { type: 'call', config: { path: 'https://x.test/a' } },
        catalog,
      ).isOk(),
    ).toBe(true);
    expect(
      issuesOf(resolveTarget(registry, { type: 'call', config: { path: '/a' } }, catalog)),
    ).toEqual([{ path: 'config.path', message: 'Needs an absolute URL without a connection' }]);
  });

  it('reports each reference problem at its path', () => {
    const cases = [
      [{ type: 'call', connection: { key: 'nope' }, config: {} }, 'connection.key'],
      [{ type: 'plain', connection: { key: 'billing' }, config: {} }, 'connection'],
      [
        { type: 'call', connection: { key: 'billing', endpoint: 'nope' }, config: undefined },
        'connection.endpoint',
      ],
      [{ type: 'missing', config: {} }, 'type'],
      [{ type: 'call', connection: { key: 'billing' }, config: {} }, 'config.path'],
    ] as const;
    for (const [ref, path] of cases) {
      expect(issuesOf(resolveTarget(registry, ref, catalog)).map((i) => i.path)).toEqual([path]);
    }
  });

  it('rejects a connection of another type and an invalid stored connection', () => {
    const other = defineConnection({
      type: 'other',
      displayName: 'Other',
      configSchema: z.object({}),
    });
    const r = new ProviderRegistry().register(api, other, call);
    const wrongType = connectionCatalog([{ ...billing, type: 'other', config: {} }]);
    expect(
      issuesOf(
        resolveTarget(
          r,
          { type: 'call', connection: { key: 'billing' }, config: { path: '/' } },
          wrongType,
        ),
      )[0]?.message,
    ).toMatch(/needs "api"/);
    const broken = connectionCatalog([{ ...billing, config: { baseUrl: 'nope' } }]);
    expect(
      issuesOf(
        resolveTarget(
          r,
          { type: 'call', connection: { key: 'billing' }, config: { path: '/' } },
          broken,
        ),
      )[0]?.message,
    ).toMatch(/is invalid/);
  });

  it('tests a connection through its definition', async () => {
    const bound = api.bind({ baseUrl: 'https://x.test' })._unsafeUnwrap();
    expect(
      await bound.test({
        secrets: mapSecretResolver({}),
        signal: AbortSignal.timeout(100),
        now: new Date(0),
      }),
    ).toEqual(ok({ message: 'Configuration is valid' }));
  });
});

const received = async (resolved: ReturnType<typeof resolveTrigger>) => {
  const messages: SourceMessage[] = [];
  await resolved._unsafeUnwrap().trigger.source?.subscribe({
    signal: AbortSignal.timeout(1_000),
    secrets: mapSecretResolver({}),
    jobId: 'j',
    emit: async (message) => {
      messages.push(message);
    },
  });

  return messages.map(({ id, body }) => ({ id, body }));
};

const triggerIssues = (ref: Parameters<typeof resolveTrigger>[1]) => {
  const result = resolveTrigger(registry, ref, catalog);

  return result.isErr() ? result.error.issues : [];
};

describe('resolveTrigger', () => {
  it('consumes over a saved connection', async () => {
    const resolved = resolveTrigger(
      registry,
      { type: 'poll', connection: { key: 'billing' }, config: { feed: '/events' } },
      catalog,
    );
    expect(resolved._unsafeUnwrap().connection).toEqual({
      key: 'billing',
      endpoint: undefined,
      version: 3,
    });
    expect(await received(resolved)).toEqual([
      { id: 'billing@3', body: 'https://billing.test/v1/events?batch=10' },
    ]);
  });

  it('runs a source endpoint with the trigger config as a merge patch', async () => {
    expect(
      await received(
        resolveTrigger(
          registry,
          {
            type: 'poll',
            connection: { key: 'billing', endpoint: 'invoices' },
            config: { batch: 50 },
          },
          catalog,
        ),
      ),
    ).toEqual([{ id: 'billing@3', body: 'https://billing.test/v1/invoices?batch=50' }]);
  });

  it('keeps inline sources working without a connection', async () => {
    expect(
      await received(
        resolveTrigger(
          registry,
          { type: 'poll', config: { feed: '/x', baseUrl: 'https://inline.test' } },
          catalog,
        ),
      ),
    ).toEqual([{ id: '@0', body: 'https://inline.test/x?batch=10' }]);
  });

  it('reports each reference problem at its path', () => {
    expect(
      triggerIssues({
        type: 'poll',
        connection: { key: 'billing' },
        config: { feed: '/x', baseUrl: 'https://other.test' },
      }),
    ).toEqual([{ path: 'config.baseUrl', message: 'Set on the "billing" connection instead' }]);
    expect(
      triggerIssues({
        type: 'poll',
        connection: { key: 'billing', endpoint: 'charge' },
        config: {},
      }),
    ).toEqual([
      { path: 'connection.endpoint', message: 'Endpoint "billing/charge" is a target endpoint' },
    ]);
    expect(
      triggerIssues({
        type: 'call',
        connection: { key: 'billing', endpoint: 'invoices' },
        config: {},
      }),
    ).toEqual([{ path: 'type', message: 'No trigger provider registered for type "call"' }]);
    expect(triggerIssues({ type: 'poll', connection: { key: 'nope' }, config: {} })).toEqual([
      { path: 'connection.key', message: 'No connection named "nope"' },
    ]);
    expect(triggerIssues({ type: 'tick', connection: { key: 'billing' }, config: {} })).toEqual([
      { path: 'connection', message: 'Trigger "tick" does not use connections' },
    ]);
    expect(
      triggerIssues({ type: 'poll', config: { feed: '/x' } }).map((issue) => issue.path),
    ).toEqual(['config.baseUrl']);
  });

  it('rejects a target endpoint used as a source', () => {
    const result = resolveTarget(
      registry,
      { type: 'call', connection: { key: 'billing', endpoint: 'invoices' }, config: undefined },
      catalog,
    );
    expect(result.isErr() ? result.error.issues : []).toEqual([
      {
        path: 'connection.endpoint',
        message: 'Endpoint "billing/invoices" is an event source endpoint',
      },
    ]);
  });
});

describe('jobConnectionRefs', () => {
  it('merges the trigger and target references', () => {
    expect(
      jobConnectionRefs(registry, {
        trigger: { connection: { key: 'billing', endpoint: 'invoices' } },
        target: { type: 'call', connection: { key: 'billing' }, config: {} },
      }),
    ).toEqual([{ key: 'billing', endpoint: 'invoices' }, { key: 'billing' }]);
    expect(
      jobConnectionRefs(registry, {
        trigger: { connection: { key: 'billing' } },
        target: { type: 'call', connection: { key: 'billing' }, config: {} },
      }),
    ).toEqual([{ key: 'billing' }]);
  });
});

describe('targetConnectionRefs', () => {
  it('collects the own reference and the ones a provider reports', () => {
    const fan = defineTarget({
      type: 'fan',
      displayName: 'Fan',
      configSchema: z.object({ keys: z.array(z.string()) }),
      connectionRefs: (config) => config.keys.map((key) => ({ key })),
      execute: async (): Promise<TargetResult> => ({ outcome: 'success', durationMs: 0 }),
    });
    const r = new ProviderRegistry().register(fan, call, api);
    expect(targetConnectionRefs(r, { type: 'fan', config: { keys: ['a', 'b', 'a'] } })).toEqual([
      { key: 'a' },
      { key: 'b' },
    ]);
    expect(
      targetConnectionRefs(r, {
        type: 'call',
        connection: { key: 'billing', endpoint: 'charge' },
        config: {},
      }),
    ).toEqual([{ key: 'billing', endpoint: 'charge' }]);
    expect(targetConnectionRefs(r, { type: 'call', config: {} })).toEqual([]);
    expect(emptyConnectionCatalog.size).toBe(0);
  });
});

describe('ProviderRegistry.list', () => {
  it('lists the fields an inline-connected target owns through its connection', () => {
    const inline = defineInlineConnectedTarget({
      type: 'inline',
      displayName: 'Inline',
      connection: api,
      configSchema: z.object({ path: z.string(), baseUrl: z.url().optional() }),
      execute: async (): Promise<TargetResult> => ({ outcome: 'success', durationMs: 0 }),
    });
    const listed = new ProviderRegistry().register(api, call, inline).list('target');

    expect(listed.find((p) => p.type === 'inline')?.connectionFields).toEqual(['baseUrl', 'token']);
    expect(listed.find((p) => p.type === 'call')?.connectionFields).toBeUndefined();
  });

  it('lists the connection of an inline-connected event source', () => {
    expect(registry.list('trigger').find((p) => p.type === 'poll')).toMatchObject({
      connectionType: 'api',
      connectionFields: ['baseUrl', 'token'],
    });
  });
});

describe('environment overlays', () => {
  it('patches the connection and its endpoints in the environment', async () => {
    const resolved = resolveTarget(
      registry,
      { type: 'call', connection: { key: 'billing', endpoint: 'charge' }, config: undefined },
      inEnvironment(catalog, 'staging'),
    )._unsafeUnwrap();
    expect((await resolved.target.execute(request)).metadata).toEqual({
      url: 'https://staging.billing.test/v1/charges',
      method: 'POST',
      headers: { b: '2', s: 'yes' },
      connection: 'billing@3',
    });
  });

  it('uses the base config without an environment or without its overlay', () => {
    expect(inEnvironment(catalog, null)).toBe(catalog);
    expect(overlayConnection(billing, 'prod')).toBe(billing);
    expect(overlayConnection(billing, null)).toBe(billing);
  });

  it('leaves endpoints without a patch untouched', () => {
    const staged = overlayConnection(billing, 'staging');
    expect(staged.endpoints[1]).toBe(billing.endpoints[1]);
    expect(billing.config).toEqual({ baseUrl: 'https://billing.test/v1' });
  });

  it('rejects duplicate environments and duplicate endpoint patches', () => {
    const parsed = ConnectionSpec.safeParse({
      key: 'billing',
      type: 'api',
      config: {},
      overlays: [
        {
          environment: 'staging',
          endpoints: [
            { key: 'a', config: {} },
            { key: 'a', config: {} },
          ],
        },
        { environment: 'staging' },
      ],
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toEqual([
      'overlays.0.endpoints.1.key',
      'overlays.1.environment',
    ]);
  });
});
