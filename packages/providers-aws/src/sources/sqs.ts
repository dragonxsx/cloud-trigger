import {
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { defineInlineConnectedEventSource } from '@cloud-trigger/core';
import { z } from 'zod';

import { awsConnection } from '../connection.js';
import { AwsConnection, clientCache, resolveClientConfig } from '../shared.js';

export const SqsSourceConfig = z.object({
  queueUrl: z.url(),
  ...AwsConnection,
  waitTimeSeconds: z.int().min(0).max(20).default(20).describe('Long-poll wait per receive.'),
  maxMessages: z.int().min(1).max(10).default(10),
  visibilityTimeoutSeconds: z
    .int()
    .min(0)
    .max(43_200)
    .optional()
    .describe('How long a message stays hidden while its run is being queued.'),
});

const sqsClient = clientCache((config) => new SQSClient({ ...config, maxAttempts: 3 }));

const headersOf = (message: Message): Record<string, string> => ({
  ...Object.fromEntries(
    Object.entries(message.MessageAttributes ?? {}).flatMap(([key, value]) =>
      value.StringValue === undefined ? [] : [[key, value.StringValue]],
    ),
  ),
  ...(message.Attributes?.['MessageGroupId'] !== undefined && {
    'sqs-message-group-id': message.Attributes['MessageGroupId'],
  }),
});

export const sqsSource = defineInlineConnectedEventSource({
  type: 'sqs',
  displayName: 'Amazon SQS queue',
  description:
    'Runs once per message. A message is deleted only after its run is queued, so delivery is at least once and deduplicated by message id.',
  configSchema: SqsSourceConfig,
  connection: awsConnection,
  exclusive: true,
  describe: (config) =>
    `On SQS message from ${config.queueUrl.split('/').at(-1) ?? config.queueUrl}`,
  async subscribe(config, { signal, secrets, emit, connection }) {
    const clientConfig = await resolveClientConfig(connection.config, secrets);
    if (clientConfig.isErr()) {
      throw new Error(clientConfig.error.message);
    }
    const client = sqsClient(clientConfig.value);
    while (!signal.aborted) {
      const received = await client
        .send(
          new ReceiveMessageCommand({
            QueueUrl: config.queueUrl,
            MaxNumberOfMessages: config.maxMessages,
            WaitTimeSeconds: config.waitTimeSeconds,
            MessageAttributeNames: ['All'],
            MessageSystemAttributeNames: ['MessageGroupId'],
            ...(config.visibilityTimeoutSeconds !== undefined && {
              VisibilityTimeout: config.visibilityTimeoutSeconds,
            }),
          }),
          { abortSignal: signal },
        )
        .catch((error: unknown) => {
          if (signal.aborted) {
            return { Messages: [] };
          }
          throw error;
        });
      for (const message of received.Messages ?? []) {
        if (message.MessageId === undefined || message.ReceiptHandle === undefined) {
          continue;
        }
        await emit({
          id: message.MessageId,
          body: message.Body ?? '',
          headers: headersOf(message),
        });
        await client.send(
          new DeleteMessageCommand({
            QueueUrl: config.queueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }),
        );
      }
    }
  },
});
