import { type MessageAttributeValue, PublishCommand, SNSClient } from '@aws-sdk/client-sns';
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

export const SnsTargetConfig = z
  .object({
    topicArn: z
      .string()
      .regex(/^arn:aws[\w-]*:sns:/, 'Must be an SNS topic ARN')
      .describe('Topic ARN. FIFO topics end in .fifo.'),
    ...AwsConnection,
    subject: z.string().max(100).optional(),
    messageGroupId: LiquidTemplate.optional().describe('FIFO only; defaults to the job id.'),
    deduplicationId: LiquidTemplate.optional().describe(
      'FIFO only; defaults to the run idempotency key.',
    ),
    attributes: z.record(z.string(), z.string()).default({}),
  })
  .refine(hasPairedCredentials, PAIRED_CREDENTIALS);

const snsClient = clientCache((config) => new SNSClient(config));

const stringAttributes = (values: Record<string, string>): Record<string, MessageAttributeValue> =>
  Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, { DataType: 'String', StringValue: value }]),
  );

export const snsTarget = defineTarget({
  type: 'sns',
  displayName: 'Amazon SNS publish',
  description: 'Publishes the payload to an SNS topic.',
  configSchema: SnsTargetConfig,
  async execute(config, { payload, ctx, signal }): Promise<TargetResult> {
    const started = performance.now();
    const elapsed = () => performance.now() - started;
    const fifo = config.topicArn.endsWith('.fifo');
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
      const sent = await snsClient(clientConfig).send(
        new PublishCommand({
          TopicArn: config.topicArn,
          Message: messageBody(payload, ctx),
          MessageAttributes: stringAttributes({
            ...payload.attributes,
            ...runAttributes(ctx),
            ...config.attributes,
          }),
          ...(config.subject !== undefined && { Subject: config.subject }),
          ...(fifo && {
            MessageGroupId: groupId ?? ctx.jobId,
            MessageDeduplicationId: dedupId(deduplication ?? deliveryKey(ctx)),
          }),
        }),
        { abortSignal: signal },
      );

      return { outcome: 'success', durationMs: elapsed(), metadata: { messageId: sent.MessageId } };
    } catch (error: unknown) {
      return awsFailure(error, signal, elapsed(), 'sns');
    }
  },
});
