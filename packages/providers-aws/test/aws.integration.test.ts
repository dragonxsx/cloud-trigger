import { setTimeout as sleep } from 'node:timers/promises';

import { CreateTopicCommand, SNSClient } from '@aws-sdk/client-sns';
import {
  CreateQueueCommand,
  type Message,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { type SourceMessage, mapSecretResolver } from '@cloud-trigger/core';
import {
  type TestHttpServer,
  contractRunContext,
  describeTargetContract,
  startTestHttpServer,
} from '@cloud-trigger/testing';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { awsConnection } from '../src/connection.js';
import { sqsSource } from '../src/sources/sqs.js';
import { eventBridgeTarget } from '../src/targets/eventbridge.js';
import { snsTarget } from '../src/targets/sns.js';
import { sqsTarget } from '../src/targets/sqs.js';

const LOCALSTACK_IMAGE = process.env['LOCALSTACK_IMAGE'] ?? 'localstack/localstack:4.14';
const CREDENTIALS = { accessKeyId: 'test', secretAccessKey: 'test' };

interface Environment {
  readonly container: StartedLocalStackContainer;
  readonly endpoint: string;
  readonly slow: TestHttpServer;
  readonly unavailable: TestHttpServer;
  readonly rejecting: TestHttpServer;
  readonly queueUrl: string;
  readonly fifoQueueUrl: string;
  readonly topicArn: string;
}

let environment: Promise<Environment> | undefined;
let resolved: Environment | undefined;

async function start(): Promise<Environment> {
  const container = await new LocalstackContainer(LOCALSTACK_IMAGE).start();
  const endpoint = container.getConnectionUri();
  const client = { region: 'us-east-1', endpoint, credentials: CREDENTIALS };
  const sqs = new SQSClient(client);
  const queue = await sqs.send(new CreateQueueCommand({ QueueName: 'contract' }));
  const fifo = await sqs.send(
    new CreateQueueCommand({
      QueueName: 'contract.fifo',
      Attributes: { FifoQueue: 'true' },
    }),
  );
  const topic = await new SNSClient(client).send(new CreateTopicCommand({ Name: 'contract' }));
  const slow = await startTestHttpServer((_req, res) => {
    setTimeout(() => res.end(), 3_000).unref();
  });
  const unavailable = await startTestHttpServer((_req, res) => {
    res.writeHead(503).end();
  });

  const rejecting = await startTestHttpServer((_req, res) => {
    res
      .writeHead(400, {
        'content-type': 'application/x-amz-json-1.1',
        'x-amzn-errortype': 'ValidationException',
      })
      .end(JSON.stringify({ __type: 'ValidationException', message: 'Detail is invalid' }));
  });

  return {
    container,
    endpoint,
    slow,
    unavailable,
    rejecting,
    queueUrl: queue.QueueUrl ?? '',
    fifoQueueUrl: fifo.QueueUrl ?? '',
    topicArn: topic.TopicArn ?? '',
  };
}

const setup = async () => {
  environment ??= start();
  resolved = await environment;
};
const env = (): Environment => {
  if (!resolved) {
    throw new Error('LocalStack environment not started');
  }

  return resolved;
};

afterAll(async () => {
  if (resolved) {
    await resolved.slow.close();
    await resolved.unavailable.close();
    await resolved.rejecting.close();
    await resolved.container.stop();
  }
}, 60_000);

const connection = () => ({ region: 'us-east-1', endpoint: env().endpoint, ...CREDENTIALS });
const broken = (server: () => TestHttpServer) => () => ({
  ...connection(),
  endpoint: server().url,
});

const receiveAll = async (queueUrl: string): Promise<Message[]> => {
  const sqs = new SQSClient({
    region: 'us-east-1',
    endpoint: env().endpoint,
    credentials: CREDENTIALS,
  });
  const received = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      MessageAttributeNames: ['All'],
      MessageSystemAttributeNames: ['All'],
      WaitTimeSeconds: 1,
    }),
  );

  return received.Messages ?? [];
};

describeTargetContract(sqsTarget, {
  setup,
  succeeding: () => ({ queueUrl: env().queueUrl, ...connection() }),
  slow: () => ({ queueUrl: env().queueUrl, ...broken(() => env().slow)() }),
  retryableFailure: () => ({ queueUrl: env().queueUrl, ...broken(() => env().unavailable)() }),
  terminalFailure: () => ({
    queueUrl: `${env().endpoint}/000000000000/does-not-exist`,
    ...connection(),
  }),
  invalid: { queueUrl: 'not a url' },
  secretPaths: [['accessKeyId'], ['secretAccessKey']],
  lastTraceparent: async () => {
    const messages = await receiveAll(env().queueUrl);

    return messages.at(-1)?.MessageAttributes?.['traceparent']?.StringValue;
  },
});

describeTargetContract(snsTarget, {
  setup,
  succeeding: () => ({ topicArn: env().topicArn, ...connection() }),
  slow: () => ({ topicArn: env().topicArn, ...broken(() => env().slow)() }),
  retryableFailure: () => ({ topicArn: env().topicArn, ...broken(() => env().unavailable)() }),
  terminalFailure: () => ({
    topicArn: 'arn:aws:sns:us-east-1:000000000000:does-not-exist',
    ...connection(),
  }),
  invalid: { topicArn: 'nope' },
  secretPaths: [['accessKeyId'], ['secretAccessKey']],
});

describeTargetContract(eventBridgeTarget, {
  setup,
  succeeding: () => ({ source: 'cloud-trigger.test', detailType: 'Tick', ...connection() }),
  slow: () => ({ source: 's', detailType: 'd', ...broken(() => env().slow)() }),
  retryableFailure: () => ({ source: 's', detailType: 'd', ...broken(() => env().unavailable)() }),
  terminalFailure: () => ({ source: 's', detailType: 'd', ...broken(() => env().rejecting)() }),
  invalid: { source: '', detailType: 'x' },
  secretPaths: [['accessKeyId'], ['secretAccessKey']],
});

describe('sqs target', () => {
  beforeAll(setup, 180_000);

  it('deduplicates FIFO sends by the run idempotency key', async () => {
    const bound = sqsTarget.bind({ queueUrl: env().fifoQueueUrl, ...connection() });
    if (bound.isErr()) {
      throw new Error(bound.error.message);
    }
    const ctx = { ...contractRunContext(), idempotencyKey: 'sched:job-1:2026-01-01T00:00:00.000Z' };
    const send = () =>
      bound.value.execute({
        payload: { body: 'hello', contentType: 'text/plain', attributes: { kind: 'tick' } },
        ctx,
        signal: AbortSignal.timeout(5_000),
      });
    expect((await send()).outcome).toBe('success');
    expect((await send()).outcome).toBe('success');

    const messages = await receiveAll(env().fifoQueueUrl);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.Body).toBe('hello');
    expect(messages[0]?.Attributes?.['MessageGroupId']).toBe(ctx.jobId);
    expect(messages[0]?.MessageAttributes?.['kind']?.StringValue).toBe('tick');
  });

  it('sends over a saved connection', async () => {
    const bound = sqsTarget
      .bind(
        { queueUrl: env().queueUrl },
        { connection: { key: 'aws', version: 1, config: connection() } },
      )
      ._unsafeUnwrap();
    const result = await bound.execute({
      payload: { body: 'via connection', contentType: 'text/plain', attributes: {} },
      ctx: contractRunContext(),
      signal: AbortSignal.timeout(5_000),
    });
    expect(result.outcome).toBe('success');
    expect((await receiveAll(env().queueUrl)).some((m) => m.Body === 'via connection')).toBe(true);
  });

  it('takes region and credentials from a connection, never from both', () => {
    const binding = { key: 'aws', version: 1, config: { region: 'eu-west-1' } };
    expect(sqsTarget.bind({ queueUrl: 'http://localhost/q' }, { connection: binding }).isOk()).toBe(
      true,
    );
    const doubled = sqsTarget.bind(
      { queueUrl: 'http://localhost/q', region: 'us-east-1' },
      { connection: binding },
    );
    expect(doubled.isErr() && doubled.error.issues).toEqual([
      { path: 'region', message: 'Set on the "aws" connection instead' },
    ]);
  });

  it('tests a connection with STS', async () => {
    const ctx = {
      secrets: mapSecretResolver({}),
      signal: AbortSignal.timeout(10_000),
      now: new Date(),
    };
    const ok = await awsConnection.bind(connection())._unsafeUnwrap().test(ctx);
    expect(ok._unsafeUnwrap().message).toMatch(/Authenticated as arn:aws/);
    const down = await awsConnection
      .bind({ ...connection(), endpoint: env().unavailable.url })
      ._unsafeUnwrap()
      .test(ctx);
    expect(down.isErr()).toBe(true);
  });

  it('rejects half-configured static credentials', () => {
    const bound = sqsTarget.bind({ queueUrl: 'http://localhost/q', accessKeyId: 'a' });
    expect(bound.isErr() && bound.error.issues[0]?.path).toBe('secretAccessKey');
  });
});

const subscribeUntil = async (
  queueUrl: string,
  onMessage: (message: SourceMessage) => Promise<void>,
  stopWhen: () => boolean,
) => {
  const bound = sqsSource.bind({
    queueUrl,
    ...connection(),
    waitTimeSeconds: 1,
    visibilityTimeoutSeconds: 1,
  });
  if (bound.isErr() || !bound.value.source) {
    throw new Error('sqs source did not bind');
  }
  const controller = new AbortController();
  const running = bound.value.source.subscribe({
    signal: controller.signal,
    secrets: mapSecretResolver({}),
    jobId: 'job-1',
    emit: onMessage,
  });
  const deadline = Date.now() + 20_000;
  while (!stopWhen() && Date.now() < deadline) {
    await sleep(50);
  }
  controller.abort();
  await running;
};

describe('sqs event source', () => {
  beforeAll(setup, 180_000);

  it('emits each message with its attributes and deletes it only after emit succeeds', async () => {
    const sqs = new SQSClient({
      region: 'us-east-1',
      endpoint: env().endpoint,
      credentials: CREDENTIALS,
    });
    const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: 'source' }));
    const queueUrl = QueueUrl ?? '';
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: '{"n":1}',
        MessageAttributes: { kind: { DataType: 'String', StringValue: 'tick' } },
      }),
    );

    const failing = sqsSource.bind(
      { queueUrl, waitTimeSeconds: 1, visibilityTimeoutSeconds: 1 },
      { connection: { key: 'aws', version: 1, config: connection() } },
    );
    await expect(
      failing._unsafeUnwrap().source?.subscribe({
        signal: AbortSignal.timeout(10_000),
        secrets: mapSecretResolver({}),
        jobId: 'job-1',
        emit: () => Promise.reject(new Error('run could not be queued')),
      }),
    ).rejects.toThrow('run could not be queued');

    const seen: SourceMessage[] = [];
    await subscribeUntil(
      queueUrl,
      (message) => {
        seen.push(message);

        return Promise.resolve();
      },
      () => seen.length > 0,
    );

    expect(seen[0]).toMatchObject({ body: '{"n":1}', headers: { kind: 'tick' } });
    expect(await receiveAll(queueUrl)).toEqual([]);
  }, 60_000);
});
