import { type MessageAttributeValue, SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  ResultAsync,
  type TargetResult,
  defineTarget,
  deliveryKey,
  failedResult,
} from '@cloud-trigger/core';
import { LiquidTemplate } from '@cloud-trigger/providers-builtin';
import { z } from 'zod';

import {
  AwsConnection,
  PAIRED_CREDENTIALS,
  awsFailure,
  clientCache,
  dedupId,
  hasPairedCredentials,
  messageBody,
  renderOptional,
  resolveClientConfig,
  runAttributes,
} from '../shared.js';

export const SqsTargetConfig = z
  .object({
    queueUrl: z.url().describe('Queue URL. FIFO queues end in .fifo.'),
    ...AwsConnection,
    messageGroupId: LiquidTemplate.optional().describe(
      'FIFO only. Liquid template; defaults to the job id.',
    ),
    deduplicationId: LiquidTemplate.optional().describe(
      'FIFO only. Liquid template; defaults to the run idempotency key.',
    ),
    delaySeconds: z.int().min(0).max(900).optional(),
    attributes: z
      .record(z.string(), z.string())
      .default({})
      .describe('String message attributes, merged over the payload attributes.'),
  })
  .refine(hasPairedCredentials, PAIRED_CREDENTIALS);
export type SqsTargetConfig = z.output<typeof SqsTargetConfig>;

const sqsClient = clientCache((config) => new SQSClient(config));

export const stringAttributes = (
  values: Record<string, string>,
): Record<string, MessageAttributeValue> =>
  Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, { DataType: 'String', StringValue: value }]),
  );

export const sqsTarget = defineTarget({
  type: 'sqs',
  displayName: 'Amazon SQS message',
  description: 'Sends the payload to an SQS queue. FIFO queues are deduplicated per run.',
  configSchema: SqsTargetConfig,
  async execute(config, { payload, ctx, signal }): Promise<TargetResult> {
    const started = performance.now();
    const elapsed = () => performance.now() - started;
    const fifo = config.queueUrl.endsWith('.fifo');
    const prepared = await ResultAsync.combine([
      resolveClientConfig(config, ctx.secrets),
      renderOptional(config.messageGroupId, ctx),
      renderOptional(config.deduplicationId, ctx),
    ] as const);
    if (prepared.isErr()) {
      return failedResult('invalid_config', prepared.error.message, false, elapsed());
    }
    const [clientConfig, groupId, deduplication] = prepared.value;

    try {
      const sent = await sqsClient(clientConfig).send(
        new SendMessageCommand({
          QueueUrl: config.queueUrl,
          MessageBody: messageBody(payload, ctx),
          MessageAttributes: stringAttributes({
            ...payload.attributes,
            ...runAttributes(ctx),
            ...config.attributes,
          }),
          ...(config.delaySeconds !== undefined && !fifo && { DelaySeconds: config.delaySeconds }),
          ...(fifo && {
            MessageGroupId: groupId ?? ctx.jobId,
            MessageDeduplicationId: dedupId(deduplication ?? deliveryKey(ctx)),
          }),
        }),
        { abortSignal: signal },
      );

      return {
        outcome: 'success',
        durationMs: elapsed(),
        metadata: {
          messageId: sent.MessageId,
          ...(sent.SequenceNumber !== undefined && { sequenceNumber: sent.SequenceNumber }),
        },
      };
    } catch (error: unknown) {
      return awsFailure(error, signal, elapsed(), 'sqs');
    }
  },
});
