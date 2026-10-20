import { randomUUID } from 'node:crypto';

import { type SourceMessage, mapSecretResolver } from '@cloud-trigger/core';
import {
  type BlackholeServer,
  contractRunContext,
  closedPort,
  describeTargetContract,
  startBlackholeServer,
} from '@cloud-trigger/testing';
import { Admin, Consumer, type Message, stringDeserializers } from '@platformatic/kafka';
import { KafkaContainer, type StartedKafkaContainer } from '@testcontainers/kafka';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { kafkaConnection } from '../src/connection.js';
import { kafkaSource } from '../src/kafka-source.js';
import { closeProducers, kafkaTarget } from '../src/kafka-target.js';

const KAFKA_IMAGE = process.env['KAFKA_IMAGE'] ?? 'confluentinc/cp-kafka:8.1.0';
const TOPIC = 'contract';

interface Environment {
  readonly container: StartedKafkaContainer;
  readonly broker: string;
  readonly blackhole: BlackholeServer;
  readonly refused: string;
}

let environment: Promise<Environment> | undefined;
let resolved: Environment | undefined;

async function createTopic(broker: string, topic: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const admin = new Admin({ clientId: 'test-admin', bootstrapBrokers: [broker] });
    try {
      await admin.createTopics({ topics: [topic], partitions: 1, replicas: 1 });

      return;
    } catch (error: unknown) {
      if (Date.now() > deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    } finally {
      await admin.close();
    }
  }
}

async function start(): Promise<Environment> {
  const container = await new KafkaContainer(KAFKA_IMAGE).withKraft().start();
  const broker = `${container.getHost()}:${container.getMappedPort(9093)}`;
  await createTopic(broker, TOPIC);
  const blackhole = await startBlackholeServer();

  return { container, broker, blackhole, refused: `127.0.0.1:${await closedPort()}` };
}

const setup = async () => {
  environment ??= start();
  resolved = await environment;
};
const env = (): Environment => {
  if (!resolved) {
    throw new Error('Kafka environment not started');
  }

  return resolved;
};

afterAll(async () => {
  await closeProducers();
  if (resolved) {
    await resolved.blackhole.close();
    await resolved.container.stop();
  }
}, 60_000);

type StringMessage = Message<string, string, string, string>;

async function readAll(topic: string, expected: number): Promise<StringMessage[]> {
  const consumer = new Consumer({
    clientId: 'test-consumer',
    groupId: `test-${randomUUID()}`,
    bootstrapBrokers: [env().broker],
    deserializers: stringDeserializers,
  });
  const stream = await consumer.consume({ topics: [topic], mode: 'earliest' });
  const messages: StringMessage[] = [];
  const deadline = setTimeout(() => void stream.close(), 10_000);
  for await (const message of stream) {
    messages.push(message);
    if (messages.length >= expected) {
      break;
    }
  }
  clearTimeout(deadline);
  await stream.close();
  await consumer.close(true);

  return messages;
}

describeTargetContract(kafkaTarget, {
  setup,
  timeoutMs: 30_000,
  succeeding: () => ({ brokers: [env().broker], topic: TOPIC }),
  withSecrets: () => ({
    brokers: ['localhost:9092'],
    topic: TOPIC,
    sasl: { mechanism: 'PLAIN', username: 'u', password: 'p' },
    tls: { enabled: true, key: 'pem' },
  }),
  slow: () => ({ brokers: [`${env().blackhole.host}:${env().blackhole.port}`], topic: TOPIC }),
  retryableFailure: () => ({ brokers: [env().refused], topic: TOPIC, timeoutMs: 1_000 }),
  terminalFailure: () => ({
    brokers: [env().broker],
    topic: TOPIC,
    headers: { padding: 'x'.repeat(2 * 1024 * 1024) },
  }),
  invalid: { brokers: ['no-port'], topic: 'bad topic' },
  secretPaths: [
    ['sasl', 'password'],
    ['tls', 'key'],
  ],
});

describe('kafka target', () => {
  beforeAll(setup, 180_000);

  it('produces key, headers and traceparent with acks=all', async () => {
    const topic = `keyed-${randomUUID()}`;
    await createTopic(env().broker, topic);

    const bound = kafkaTarget.bind({
      brokers: [env().broker],
      topic,
      key: '{{ run.jobId }}',
      headers: { source: 'test' },
    });
    if (bound.isErr()) {
      throw new Error(bound.error.message);
    }
    const result = await bound.value.execute({
      payload: { body: '{"n":1}', contentType: 'application/json', attributes: {} },
      ctx: contractRunContext(),
      signal: AbortSignal.timeout(30_000),
    });
    expect(result.outcome).toBe('success');
    expect(result.metadata).toMatchObject({ topic, partition: 0, offset: '0' });

    const [message] = await readAll(topic, 1);
    expect(message?.key).toBe(contractRunContext().jobId);
    expect(message?.value).toBe('{"n":1}');
    expect(message?.headers.get('source')).toBe('test');
    expect(message?.headers.get('traceparent')).toBe(contractRunContext().traceparent);
  });

  it('produces over a saved connection and tests it', async () => {
    const topic = `connected-${randomUUID()}`;
    await createTopic(env().broker, topic);
    const binding = { key: 'events', version: 1, config: { brokers: [env().broker] } };
    const bound = kafkaTarget.bind({ topic }, { connection: binding })._unsafeUnwrap();
    const result = await bound.execute({
      payload: { body: 'via connection', contentType: undefined, attributes: {} },
      ctx: contractRunContext(),
      signal: AbortSignal.timeout(30_000),
    });
    expect(result.outcome).toBe('success');
    expect((await readAll(topic, 1))[0]?.value).toBe('via connection');

    const doubled = kafkaTarget.bind({ topic, brokers: [env().broker] }, { connection: binding });
    expect(doubled.isErr() && doubled.error.issues.map((i) => i.path)).toEqual(['brokers']);
    expect(kafkaTarget.bind({ topic }).isErr()).toBe(true);

    const ctx = {
      secrets: mapSecretResolver({}),
      signal: AbortSignal.timeout(30_000),
      now: new Date(),
    };
    const tested = await kafkaConnection.bind(binding.config)._unsafeUnwrap().test(ctx);
    expect(tested._unsafeUnwrap().message).toMatch(/topics visible/);
    const refused = await kafkaConnection
      .bind({ brokers: [env().refused], timeoutMs: 1_000 })
      ._unsafeUnwrap()
      .test({ ...ctx, signal: AbortSignal.timeout(10_000) });
    expect(refused.isErr()).toBe(true);
  });

  it('does not auto-create missing topics', async () => {
    const bound = kafkaTarget.bind({
      brokers: [env().broker],
      topic: 'missing-topic',
      timeoutMs: 2_000,
    });
    if (bound.isErr()) {
      throw new Error(bound.error.message);
    }
    const result = await bound.value.execute({
      payload: { body: 'x', contentType: undefined, attributes: {} },
      ctx: contractRunContext(),
      signal: AbortSignal.timeout(30_000),
    });
    expect(result.outcome).toBe('failure');
  });
});

describe('kafka event source', () => {
  beforeAll(setup, 180_000);

  it('emits records and commits offsets only after emit succeeds', async () => {
    const topic = `source-${randomUUID()}`;
    await createTopic(env().broker, topic);
    const target = kafkaTarget.bind({ brokers: [env().broker], topic })._unsafeUnwrap();
    await target.execute({
      payload: { body: '{"n":1}', contentType: undefined, attributes: { kind: 'tick' } },
      ctx: contractRunContext(),
      signal: AbortSignal.timeout(30_000),
    });

    const sourceConfig = { topics: [topic], fromBeginning: true, groupId: `g-${topic}` };
    const connection = { key: 'events', version: 1, config: { brokers: [env().broker] } };
    const doubled = kafkaSource.bind({ ...sourceConfig, brokers: ['x:1'] }, { connection });
    expect(doubled.isErr() && doubled.error.issues.map((i) => i.path)).toEqual(['brokers']);
    expect(kafkaSource.bind(sourceConfig).isErr()).toBe(true);
    const source = kafkaSource.bind(sourceConfig, { connection })._unsafeUnwrap().source;
    if (!source) {
      throw new Error('kafka source did not bind');
    }
    const consume = (emit: (message: SourceMessage) => Promise<void>, stopAfterMs: number) => {
      const signal = AbortSignal.timeout(stopAfterMs);

      return source.subscribe({ signal, secrets: mapSecretResolver({}), jobId: 'job-1', emit });
    };

    await expect(consume(() => Promise.reject(new Error('not queued')), 20_000)).rejects.toThrow(
      'not queued',
    );
    const seen: SourceMessage[] = [];
    const controller = new AbortController();
    const running = source.subscribe({
      signal: controller.signal,
      secrets: mapSecretResolver({}),
      jobId: 'job-1',
      emit: (message) => {
        seen.push(message);
        controller.abort();

        return Promise.resolve();
      },
    });
    await running;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      id: `${topic}:0:0`,
      body: '{"n":1}',
      headers: { kind: 'tick' },
    });

    const again: SourceMessage[] = [];
    await consume((message) => {
      again.push(message);

      return Promise.resolve();
    }, 3_000);
    expect(again).toEqual([]);
  }, 90_000);
});
