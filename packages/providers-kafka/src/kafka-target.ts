import {
  ResultAsync,
  type TargetResult,
  abortable,
  defineInlineConnectedTarget,
  failedResult,
  okAsync,
  toError,
} from '@cloud-trigger/core';
import { LiquidTemplate, renderWithSecrets, templateScope } from '@cloud-trigger/providers-builtin';
import { Producer, stringSerializers } from '@platformatic/kafka';
import { z } from 'zod';

import {
  type KafkaClientOptions,
  KafkaConnectionConfig,
  kafkaConnection,
  kafkaFailure,
  optionsKey,
  resolveConnection,
} from './connection.js';

export const KafkaTargetConfig = z.object({
  ...KafkaConnectionConfig.partial().shape,
  topic: z
    .string()
    .regex(/^[\w.-]{1,249}$/, 'Letters, digits, ".", "_" and "-" only')
    .describe('The topic must already exist; it is not auto-created.'),
  key: LiquidTemplate.optional().describe('Message key as a Liquid template; null when empty.'),
  headers: z.record(z.string(), z.string()).default({}),
});
export type KafkaTargetConfig = z.output<typeof KafkaTargetConfig>;

type StringProducer = Producer<string, string, string, string>;
const producers = new Map<string, StringProducer>();

const producerFor = (options: KafkaClientOptions): StringProducer => {
  const key = optionsKey(options);
  const existing = producers.get(key);
  if (existing) {
    return existing;
  }
  const producer = new Producer({
    ...options,
    serializers: stringSerializers,
    acks: -1,
    retries: 0,
    autocreateTopics: false,
  });
  producers.set(key, producer);

  return producer;
};

export const closeProducers = async (): Promise<void> => {
  const open = [...producers.values()];
  producers.clear();
  await Promise.allSettled(open.map((producer) => producer.close(true)));
};

export const kafkaTarget = defineInlineConnectedTarget({
  type: 'kafka',
  displayName: 'Kafka message',
  description: 'Produces the payload to a Kafka topic with acks=all.',
  configSchema: KafkaTargetConfig,
  connection: kafkaConnection,
  async execute(config, { payload, ctx, signal, connection }): Promise<TargetResult> {
    const started = performance.now();
    const elapsed = () => performance.now() - started;
    const prepared = await ResultAsync.combine([
      resolveConnection(connection.config, ctx.secrets),
      config.key === undefined
        ? okAsync(undefined)
        : ResultAsync.fromPromise(
            renderWithSecrets(config.key, templateScope(ctx), ctx.secrets),
            toError,
          ),
    ] as const);
    if (prepared.isErr()) {
      return failedResult('invalid_config', prepared.error.message, false, elapsed());
    }
    const [options, key] = prepared.value;

    try {
      const produced = await abortable(
        signal,
        producerFor(options).send({
          messages: [
            {
              topic: config.topic,
              ...(key !== undefined && key !== '' && { key }),
              value: payload.body ?? '',
              headers: {
                ...payload.attributes,
                'x-cloud-trigger-run-id': ctx.runId,
                'x-cloud-trigger-attempt': String(ctx.attempt),
                ...(ctx.traceparent !== undefined && { traceparent: ctx.traceparent }),
                ...config.headers,
              },
            },
          ],
        }),
      );
      const [offset] = produced.offsets ?? [];

      return {
        outcome: 'success',
        durationMs: elapsed(),
        metadata: offset
          ? { topic: offset.topic, partition: offset.partition, offset: String(offset.offset) }
          : { topic: config.topic },
      };
    } catch (error: unknown) {
      return kafkaFailure(error, signal, elapsed());
    }
  },
});
