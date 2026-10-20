import { type SourceMessage, mapSecretResolver } from '@cloud-trigger/core';
import {
  type BlackholeServer,
  closedPort,
  contractRunContext,
  describeTargetContract,
  startBlackholeServer,
} from '@cloud-trigger/testing';
import { jetstreamManager } from '@nats-io/jetstream';
import { type NatsConnection, connect } from '@nats-io/transport-node';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { natsSource } from '../src/nats-source.js';
import { closeConnections, natsConnection, natsTarget } from '../src/nats-target.js';

const NATS_IMAGE = process.env['NATS_IMAGE'] ?? 'nats:2.12-alpine';

interface Environment {
  readonly container: StartedTestContainer;
  readonly server: string;
  readonly observer: NatsConnection;
  readonly blackhole: BlackholeServer;
  readonly refused: string;
  readonly traceparents: string[];
  readonly coreMessages: string[];
}

let environment: Promise<Environment> | undefined;
let resolved: Environment | undefined;

async function start(): Promise<Environment> {
  const container = await new GenericContainer(NATS_IMAGE)
    .withCommand(['-js'])
    .withExposedPorts(4222)
    .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
    .start();
  const server = `nats://${container.getHost()}:${container.getMappedPort(4222)}`;
  const observer = await connect({ servers: [server] });
  const manager = await jetstreamManager(observer);
  await manager.streams.add({ name: 'CONTRACT', subjects: ['contract.>'] });
  const traceparents: string[] = [];
  const coreMessages: string[] = [];
  observer.subscribe('contract.>', {
    callback: (_error, msg) => {
      const traceparent = msg.headers?.get('traceparent');
      if (traceparent) {
        traceparents.push(traceparent);
      }
    },
  });
  observer.subscribe('plain.>', {
    callback: (_error, msg) => {
      coreMessages.push(msg.string());
    },
  });
  await observer.flush();
  const blackhole = await startBlackholeServer();

  return {
    container,
    server,
    observer,
    blackhole,
    refused: `nats://127.0.0.1:${await closedPort()}`,
    traceparents,
    coreMessages,
  };
}

const setup = async () => {
  environment ??= start();
  resolved = await environment;
};
const env = (): Environment => {
  if (!resolved) {
    throw new Error('NATS environment not started');
  }

  return resolved;
};

afterAll(async () => {
  await closeConnections();
  if (resolved) {
    await resolved.observer.close();
    await resolved.blackhole.close();
    await resolved.container.stop();
  }
}, 60_000);

describeTargetContract(natsTarget, {
  setup,
  succeeding: () => ({ servers: [env().server], subject: 'contract.events' }),
  withSecrets: () => ({
    servers: ['nats://localhost:4222'],
    subject: 'contract.events',
    auth: { type: 'token', token: 't0ken' },
  }),
  slow: () => ({
    servers: [`nats://${env().blackhole.host}:${env().blackhole.port}`],
    subject: 'contract.events',
  }),
  retryableFailure: () => ({
    servers: [env().refused],
    subject: 'contract.events',
    timeoutMs: 1_000,
  }),
  terminalFailure: () => ({
    servers: [env().server],
    subject: 'nostream.events',
    timeoutMs: 2_000,
  }),
  invalid: { servers: [], subject: 'a.*' },
  secretPaths: [['auth', 'token']],
  lastTraceparent: async () => {
    await env().observer.flush();

    return env().traceparents.at(-1);
  },
});

const publish = async (config: Record<string, unknown>, idempotencyKey: string) => {
  const bound = natsTarget.bind(config);
  if (bound.isErr()) {
    throw new Error(bound.error.message);
  }

  return bound.value.execute({
    payload: { body: 'hello', contentType: 'text/plain', attributes: {} },
    ctx: { ...contractRunContext(), idempotencyKey },
    signal: AbortSignal.timeout(5_000),
  });
};

describe('nats target', () => {
  beforeAll(setup, 180_000);

  it('deduplicates JetStream publishes by the run idempotency key', async () => {
    const config = { servers: [env().server], subject: 'contract.dedup' };
    const first = await publish(config, 'manual:job:abc');
    const second = await publish(config, 'manual:job:abc');
    expect(first.metadata).toMatchObject({ stream: 'CONTRACT', duplicate: false });
    expect(second.metadata).toMatchObject({ stream: 'CONTRACT', duplicate: true });
  });

  it('publishes over a saved connection and tests it', async () => {
    const binding = { key: 'bus', version: 1, config: { servers: [env().server] } };
    const bound = natsTarget
      .bind({ subject: 'plain.events', mode: 'core' }, { connection: binding })
      ._unsafeUnwrap();
    const result = await bound.execute({
      payload: { body: 'via connection', contentType: 'text/plain', attributes: {} },
      ctx: contractRunContext(),
      signal: AbortSignal.timeout(5_000),
    });
    expect(result.outcome).toBe('success');
    await env().observer.flush();
    expect(env().coreMessages).toContain('via connection');
    const doubled = natsTarget.bind(
      { subject: 'plain.events', servers: [env().server] },
      { connection: binding },
    );
    expect(doubled.isErr() && doubled.error.issues.map((i) => i.path)).toEqual(['servers']);

    const ctx = {
      secrets: mapSecretResolver({}),
      signal: AbortSignal.timeout(5_000),
      now: new Date(),
    };
    const tested = await natsConnection.bind(binding.config)._unsafeUnwrap().test(ctx);
    expect(tested._unsafeUnwrap().message).toMatch(/Connected/);
    const refused = await natsConnection
      .bind({ servers: [env().refused], timeoutMs: 1_000 })
      ._unsafeUnwrap()
      .test(ctx);
    expect(refused.isErr()).toBe(true);
  });

  it('publishes core messages without a stream', async () => {
    const result = await publish(
      { servers: [env().server], subject: 'plain.events', mode: 'core' },
      'k',
    );
    expect(result.outcome).toBe('success');
    await env().observer.flush();
    expect(env().coreMessages).toContain('hello');
  });
});

describe('nats event source', () => {
  beforeAll(setup, 180_000);

  it('consumes through a durable consumer and acks only after emit succeeds', async () => {
    await publish({ servers: [env().server], subject: 'contract.source' }, 'source-1');
    const source = natsSource
      .bind(
        {
          stream: 'CONTRACT',
          durable: 'source-test',
          filterSubject: 'contract.source',
          ackWaitMs: 1_000,
        },
        { connection: { key: 'bus', version: 1, config: { servers: [env().server] } } },
      )
      ._unsafeUnwrap().source;
    if (!source) {
      throw new Error('nats source did not bind');
    }
    await expect(
      source.subscribe({
        signal: AbortSignal.timeout(10_000),
        secrets: mapSecretResolver({}),
        jobId: 'job-1',
        emit: () => Promise.reject(new Error('not queued')),
      }),
    ).rejects.toThrow('not queued');

    const seen: SourceMessage[] = [];
    const controller = new AbortController();
    await source.subscribe({
      signal: controller.signal,
      secrets: mapSecretResolver({}),
      jobId: 'job-1',
      emit: (message) => {
        seen.push(message);
        controller.abort();

        return Promise.resolve();
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.body).toBe('hello');
    expect(seen[0]?.id).toMatch(/^CONTRACT:\d+$/);
    expect(seen[0]?.headers['x-cloud-trigger-run-id']).toBe(contractRunContext().runId);

    const again: SourceMessage[] = [];
    await source.subscribe({
      signal: AbortSignal.timeout(2_000),
      secrets: mapSecretResolver({}),
      jobId: 'job-1',
      emit: (message) => {
        again.push(message);

        return Promise.resolve();
      },
    });
    expect(again).toEqual([]);
  }, 60_000);
});
