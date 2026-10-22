import 'reflect-metadata';
import { type TestHttpServer, startTestHttpServer } from '@cloud-trigger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type TestServer, startTestServer } from './support/app.js';
import { type Client, errorCode, rejection, waitForRun } from './support/client.js';
import { tempSqlite } from './support/databases.js';

const sqlite = tempSqlite('connections-e2e');
let server: TestServer;
let target: TestHttpServer;
let api: Client;

beforeAll(async () => {
  target = await startTestHttpServer((req, res) => {
    res.writeHead(req.headers.authorization === 'Bearer live-token' ? 200 : 401).end('{}');
  });
  server = await startTestServer(sqlite.env);
  api = server.client();
});

afterAll(async () => {
  await server.close();
  await target.close();
  sqlite.cleanup();
});

const billing = () => ({
  key: 'billing',
  name: 'Billing API',
  type: 'http',
  config: { baseUrl: `${target.url}/v1`, auth: { type: 'bearer', token: 'live-token' } },
  endpoints: [
    { key: 'charge', target: { type: 'http', config: { method: 'POST', url: '/charges' } } },
  ],
});

describe('connections API', () => {
  it('publishes connection providers and the connection type of targets', async () => {
    const providers = await api.providers.list({});
    expect(providers.find((p) => p.kind === 'connection' && p.type === 'http')).toBeDefined();
    expect(providers.find((p) => p.kind === 'target' && p.type === 'http')?.connectionType).toBe(
      'http',
    );
  });

  it('creates, redacts, restores, tests, uses and deletes a connection', async () => {
    const created = await api.connections.create(billing());
    expect(created.config).toMatchObject({ auth: { type: 'bearer', token: '***' } });
    expect((await api.connections.get({ key: 'billing' })).endpoints).toHaveLength(1);
    expect((await api.connections.list({ limit: 10 })).items.map((c) => c.key)).toEqual([
      'billing',
    ]);

    const tested = await api.connections.test({
      key: 'billing',
      type: 'http',
      config: created.config,
    });
    expect(tested).toMatchObject({ ok: true });
    expect(
      await api.connections.test({ type: 'http', config: { baseUrl: `${target.url}/v1` } }),
    ).toMatchObject({ ok: false });

    const updated = await api.connections.update({
      ...billing(),
      name: 'Billing',
      config: created.config,
      expectedVersion: created.version,
    });
    expect(updated.version).toBe(2);

    const job = await api.jobs.create({
      name: 'charge nightly',
      trigger: { type: 'manual', config: {} },
      target: { type: 'http', connection: { key: 'billing', endpoint: 'charge' }, config: {} },
    });
    await api.jobs.run({ id: job.id });
    const run = await waitForRun(api, job.id);
    expect(run.status).toBe('succeeded');
    expect(target.requests.at(-1)).toMatchObject({ method: 'POST', url: '/v1/charges' });

    expect(await api.connections.usages({ key: 'billing' })).toEqual({
      jobs: [{ id: job.id, name: 'charge nightly', enabled: true, endpoints: ['charge'] }],
      groups: [],
    });
    const deleting = await errorCode(api.connections.delete({ key: 'billing' }));
    expect(deleting).toBe('CONFLICT');
    const breaking = await errorCode(
      api.connections.update({
        ...billing(),
        endpoints: [],
        config: created.config,
        expectedVersion: 2,
      }),
    );
    expect(breaking).toBe('INVALID_CONFIG');

    const exported = await api.jobs.export({});
    const yaml = await exported.text();
    expect(yaml).toContain('endpoint: charge');
    const imported = await api.jobs.import({ yaml, mode: 'upsert', dryRun: true });
    expect(imported).toMatchObject({ issues: [], unchanged: ['charge nightly'] });

    await api.jobs.delete({ id: job.id });
    expect(await api.connections.delete({ key: 'billing' })).toEqual({ deleted: true });
    expect(await errorCode(api.connections.get({ key: 'billing' }))).toBe('NOT_FOUND');
  });

  it('imports OpenAPI operations as endpoints and runs one with path parameters', async () => {
    const spec = [
      'swagger: "2.0"',
      'info: { title: Pets, version: "1" }',
      `host: ${new URL(target.url).host}`,
      'basePath: /v1',
      'schemes: [http]',
      'securityDefinitions: { token: { type: apiKey, in: header, name: Authorization } }',
      'paths:',
      '  /pets/{petId}:',
      '    get:',
      '      operationId: getPetById',
      '      parameters: [{ name: petId, in: path, required: true, type: string }]',
    ].join('\n');
    const analysis = await api.connections.openapiPreview({ source: { kind: 'text', text: spec } });
    expect(analysis).toMatchObject({
      info: { title: 'Pets', openapi: '2.0' },
      servers: [`${target.url}/v1`],
      auth: { type: 'api_key', in: 'header', name: 'Authorization' },
      warnings: [],
    });
    const [operation] = analysis.operations;
    expect(operation?.endpoint.key).toBe('get-pet-by-id');

    await api.connections.create({
      key: 'pets',
      type: 'http',
      config: { baseUrl: analysis.servers[0], auth: { type: 'bearer', token: 'live-token' } },
      endpoints: analysis.operations.map((op) => op.endpoint),
    });
    const job = await api.jobs.create({
      name: 'fetch pet',
      trigger: { type: 'manual', config: {} },
      target: {
        type: 'http',
        connection: { key: 'pets', endpoint: 'get-pet-by-id' },
        config: { pathParams: { petId: 'rex 1' } },
      },
    });
    await api.jobs.run({ id: job.id });
    expect((await waitForRun(api, job.id)).status).toBe('succeeded');
    expect(target.requests.at(-1)).toMatchObject({ method: 'GET', url: '/v1/pets/rex%201' });

    await api.jobs.delete({ id: job.id });
    await api.connections.delete({ key: 'pets' });
  });

  it('refuses to fetch OpenAPI documents from private addresses by default', async () => {
    expect(
      await rejection(
        api.connections.openapiPreview({
          source: { kind: 'url', url: `${target.url}/openapi.json` },
        }),
      ),
    ).toMatchObject({
      data: {
        issues: [
          { path: 'source.url', message: 'The host resolves to a private or internal address' },
        ],
      },
    });
  });

  it('rejects a job that references an unknown connection with a field issue', async () => {
    expect(
      await rejection(
        api.jobs.create({
          name: 'orphan',
          trigger: { type: 'manual', config: {} },
          target: { type: 'http', connection: { key: 'nope' }, config: { url: '/x' } },
        }),
      ),
    ).toMatchObject({
      data: {
        issues: [{ path: 'target.connection.key', message: 'No connection named "nope"' }],
      },
    });
  });

  it('runs an event-source trigger over a source endpoint', async () => {
    const providers = await api.providers.list({ kind: 'trigger' });
    const kafka = providers.find((p) => p.type === 'kafka');
    expect(kafka?.connectionType).toBe('kafka');
    expect(kafka?.connectionFields).toContain('brokers');

    const events = {
      key: 'events',
      type: 'kafka',
      config: {
        brokers: ['kafka.invalid:9092'],
        sasl: { mechanism: 'PLAIN', username: 'svc', password: 'hunter2' },
      },
      endpoints: [
        { key: 'orders', source: { type: 'kafka', config: { topics: ['orders'] } } },
        { key: 'publish', target: { type: 'kafka', config: { topic: 'orders' } } },
      ],
    };
    const created = await api.connections.create(events);
    expect(created.config).toMatchObject({ sasl: { password: '***' } });
    expect(created.endpoints[0]).toMatchObject({
      key: 'orders',
      source: { type: 'kafka', config: { topics: ['orders'] } },
    });

    const job = await api.jobs.create({
      name: 'on order',
      enabled: false,
      trigger: {
        type: 'kafka',
        connection: { key: 'events', endpoint: 'orders' },
        config: { groupId: 'billing' },
      },
      target: { type: 'kafka', connection: { key: 'events', endpoint: 'publish' }, config: {} },
    });
    expect(await api.connections.usages({ key: 'events' })).toEqual({
      jobs: [{ id: job.id, name: 'on order', enabled: false, endpoints: ['orders', 'publish'] }],
      groups: [],
    });

    expect(
      await rejection(
        api.jobs.create({
          name: 'wrong',
          trigger: {
            type: 'kafka',
            connection: { key: 'events', endpoint: 'publish' },
            config: {},
          },
          target: { type: 'http', config: { url: `${target.url}/x` } },
        }),
      ),
    ).toMatchObject({
      data: {
        issues: [
          {
            path: 'trigger.connection.endpoint',
            message: 'Endpoint "events/publish" is a target endpoint',
          },
        ],
      },
    });

    const restored = await api.connections.update({
      ...events,
      config: created.config,
      endpoints: created.endpoints,
      expectedVersion: created.version,
    });
    expect(restored.version).toBe(2);
    const breaking = await errorCode(
      api.connections.update({
        ...events,
        config: created.config,
        endpoints: created.endpoints.slice(1),
        expectedVersion: 2,
      }),
    );
    expect(breaking).toBe('INVALID_CONFIG');

    await api.jobs.delete({ id: job.id });
    expect(await api.connections.delete({ key: 'events' })).toEqual({ deleted: true });
  });

  it('notifies over a slack connection from group defaults and redacts notifier endpoints', async () => {
    const slack = {
      key: 'chatops',
      type: 'slack',
      config: { url: `${target.url}/slack` },
      endpoints: [
        {
          key: 'alerts',
          notifier: {
            type: 'slack',
            config: { channel: '#alerts', template: '{{ job.name }} {{ event }}' },
          },
        },
      ],
    };
    const created = await api.connections.create(slack);
    expect(created.config).toEqual({ url: '***' });

    const group = await api.groups.create({
      name: 'ops',
      defaultNotifications: [
        {
          on: ['permanent_failure'],
          notifier: {
            type: 'slack',
            config: { channel: '#oncall' },
            connection: { key: 'chatops', endpoint: 'alerts' },
          },
        },
      ],
    });
    expect(await api.connections.usages({ key: 'chatops' })).toEqual({
      jobs: [],
      groups: [{ id: group.id, name: 'ops', endpoints: ['alerts'] }],
    });

    const restored = await api.connections.update({
      ...slack,
      config: created.config,
      expectedVersion: created.version,
    });
    expect(restored.version).toBe(2);
    expect(
      await api.connections.test({ key: 'chatops', type: 'slack', config: restored.config }),
    ).toEqual({
      ok: true,
      message: 'Configuration is valid',
    });

    expect(
      await rejection(
        api.groups.create({
          name: 'broken',
          defaultNotifications: [
            {
              on: ['success'],
              notifier: {
                type: 'slack',
                config: {},
                connection: { key: 'chatops', endpoint: 'nope' },
              },
            },
          ],
        }),
      ),
    ).toMatchObject({
      data: {
        issues: [
          {
            path: 'defaultNotifications.0.notifier.connection.endpoint',
            message: 'Connection "chatops" has no endpoint "nope"',
          },
        ],
      },
    });

    expect(await errorCode(api.connections.delete({ key: 'chatops' }))).toBe('CONFLICT');
    await api.groups.delete({ id: group.id });
    expect(await api.connections.delete({ key: 'chatops' })).toEqual({ deleted: true });
  });
});

describe('environments API', () => {
  it('manages environments and refuses to delete one in use', async () => {
    const staging = await api.environments.create({ key: 'staging', name: 'Staging' });
    expect(staging).toMatchObject({ key: 'staging', name: 'Staging', version: 1 });
    expect(await errorCode(api.environments.create({ key: 'staging' }))).toBe('CONFLICT');
    const renamed = await api.environments.update({
      key: 'staging',
      name: 'Pre-production',
      expectedVersion: 1,
    });
    expect(renamed.version).toBe(2);
    expect((await api.environments.list({ limit: 10 })).items.map((e) => e.key)).toEqual([
      'staging',
    ]);

    const group = await api.groups.create({ name: 'staged', environment: 'staging' });
    expect(await errorCode(api.environments.delete({ key: 'staging' }))).toBe('CONFLICT');
    await api.groups.delete({ id: group.id });
    expect(await api.environments.delete({ key: 'staging' })).toEqual({ deleted: true });
    expect(await errorCode(api.environments.get({ key: 'staging' }))).toBe('NOT_FOUND');
  });

  it('redacts overlay secrets, restores them and runs a job in its environment', async () => {
    await api.environments.create({ key: 'qa' });
    const created = await api.connections.create({
      ...billing(),
      key: 'ledger',
      config: { baseUrl: `${target.url}/v1`, auth: { type: 'bearer', token: 'wrong' } },
      overlays: [
        {
          environment: 'qa',
          config: { baseUrl: `${target.url}/qa`, auth: { type: 'bearer', token: 'live-token' } },
          endpoints: [{ key: 'charge', config: { url: '/test-charges' } }],
        },
      ],
    });
    const [overlay] = created.overlays;
    expect(overlay?.config).toMatchObject({ auth: { token: '***' } });

    expect(
      await api.connections.test({
        key: 'ledger',
        type: 'http',
        config: created.config,
        overlay: { environment: 'qa', config: overlay?.config },
      }),
    ).toMatchObject({ ok: true });

    const updated = await api.connections.update({
      ...created,
      name: 'Ledger',
      expectedVersion: created.version,
    });
    expect(updated.overlays[0]?.config).toMatchObject({ auth: { token: '***' } });

    const job = await api.jobs.create({
      name: 'qa charge',
      environment: 'qa',
      trigger: { type: 'manual', config: {} },
      target: { type: 'http', connection: { key: 'ledger', endpoint: 'charge' }, config: {} },
    });
    expect((await api.jobs.list({ limit: 10, environment: 'qa' })).items.map((j) => j.id)).toEqual([
      job.id,
    ]);
    await api.jobs.run({ id: job.id });
    expect((await waitForRun(api, job.id)).status).toBe('succeeded');
    expect(target.requests.at(-1)).toMatchObject({ method: 'POST', url: '/qa/test-charges' });

    await api.jobs.delete({ id: job.id });
    await api.connections.delete({ key: 'ledger' });
    expect(await api.environments.delete({ key: 'qa' })).toEqual({ deleted: true });
  });
});
