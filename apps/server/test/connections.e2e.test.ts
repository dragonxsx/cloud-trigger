import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Contract, contract } from '@cloud-trigger/api-contract';
import { type TestHttpServer, startTestHttpServer } from '@cloud-trigger/testing';
import type { INestApplication } from '@nestjs/common';
import { ORPCError, createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import type { JsonifiedClient } from '@orpc/openapi-client';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { loadConfig } from '../src/config/config.js';
import { createTestApp } from './support/app.js';

type Client = JsonifiedClient<ContractRouterClient<Contract>>;

const dir = mkdtempSync(join(tmpdir(), 'ct-connections-e2e-'));
let app: INestApplication;
let target: TestHttpServer;
let api: Client;

beforeAll(async () => {
  target = await startTestHttpServer((req, res) => {
    res.writeHead(req.headers.authorization === 'Bearer live-token' ? 200 : 401).end('{}');
  });
  const config = loadConfig({
    DB_DRIVER: 'sqlite',
    SQLITE_PATH: join(dir, 'app.db'),
    WORKER_POLL_MS: '100',
    SCHEDULER_INTERVAL_MS: '200',
  });
  ({ app } = await createTestApp(config));
  app.enableShutdownHooks();
  await app.init();
  const http: unknown = app.getHttpServer();
  if (!(http instanceof Server)) {
    throw new Error('Expected a node:http server');
  }
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (address === null || typeof address === 'string') {
    throw new Error('tcp');
  }
  api = createORPCClient(new OpenAPILink(contract, { url: `http://127.0.0.1:${address.port}` }));
}, 60_000);

afterAll(async () => {
  await app.close();
  await target.close();
  rmSync(dir, { recursive: true, force: true });
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

const ErrorWithCode = z.object({ code: z.string() });
const errorCode = (error: unknown): string => {
  const parsed = ErrorWithCode.safeParse(error);

  return parsed.success ? parsed.data.code : 'unknown';
};

const waitForRun = async (jobId: string) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [run] = (await api.runs.list({ jobId, limit: 1 })).items;
    if (run && run.status !== 'pending' && run.status !== 'running') {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('run did not finish');
};

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
    const run = await waitForRun(job.id);
    expect(run.status).toBe('succeeded');
    expect(target.requests.at(-1)).toMatchObject({ method: 'POST', url: '/v1/charges' });

    expect(await api.connections.usages({ key: 'billing' })).toEqual({
      jobs: [{ id: job.id, name: 'charge nightly', enabled: true, endpoints: ['charge'] }],
      groups: [],
    });
    const deleting = await api.connections.delete({ key: 'billing' }).catch(errorCode);
    expect(deleting).toBe('CONFLICT');
    const breaking = await api.connections
      .update({ ...billing(), endpoints: [], config: created.config, expectedVersion: 2 })
      .catch(errorCode);
    expect(breaking).toBe('INVALID_CONFIG');

    const exported = await api.jobs.export({});
    const yaml = await exported.text();
    expect(yaml).toContain('endpoint: charge');
    const imported = await api.jobs.import({ yaml, mode: 'upsert', dryRun: true });
    expect(imported).toMatchObject({ issues: [], unchanged: ['charge nightly'] });

    await api.jobs.delete({ id: job.id });
    expect(await api.connections.delete({ key: 'billing' })).toEqual({ deleted: true });
    expect(await api.connections.get({ key: 'billing' }).catch(errorCode)).toBe('NOT_FOUND');
  });

  it('rejects a job that references an unknown connection with a field issue', async () => {
    const failure = await api.jobs
      .create({
        name: 'orphan',
        trigger: { type: 'manual', config: {} },
        target: { type: 'http', connection: { key: 'nope' }, config: { url: '/x' } },
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ORPCError);
    expect(failure instanceof ORPCError ? failure.data : undefined).toEqual({
      issues: [{ path: 'target.connection.key', message: 'No connection named "nope"' }],
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

    const wrongKind = await api.jobs
      .create({
        name: 'wrong',
        trigger: { type: 'kafka', connection: { key: 'events', endpoint: 'publish' }, config: {} },
        target: { type: 'http', config: { url: `${target.url}/x` } },
      })
      .catch((error: unknown) => error);
    expect(wrongKind instanceof ORPCError ? wrongKind.data : undefined).toEqual({
      issues: [
        {
          path: 'trigger.connection.endpoint',
          message: 'Endpoint "events/publish" is a target endpoint',
        },
      ],
    });

    const restored = await api.connections.update({
      ...events,
      config: created.config,
      endpoints: created.endpoints,
      expectedVersion: created.version,
    });
    expect(restored.version).toBe(2);
    const breaking = await api.connections
      .update({
        ...events,
        config: created.config,
        endpoints: created.endpoints.slice(1),
        expectedVersion: 2,
      })
      .catch(errorCode);
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

    const missing = await api.groups
      .create({
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
      })
      .catch((error: unknown) => error);
    expect(missing instanceof ORPCError ? missing.data : undefined).toEqual({
      issues: [
        {
          path: 'defaultNotifications.0.notifier.connection.endpoint',
          message: 'Connection "chatops" has no endpoint "nope"',
        },
      ],
    });

    expect(await api.connections.delete({ key: 'chatops' }).catch(errorCode)).toBe('CONFLICT');
    await api.groups.delete({ id: group.id });
    expect(await api.connections.delete({ key: 'chatops' })).toEqual({ deleted: true });
  });
});
