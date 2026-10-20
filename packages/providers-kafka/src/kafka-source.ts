import { defineInlineConnectedEventSource } from '@cloud-trigger/core';
import { Consumer, stringDeserializers } from '@platformatic/kafka';
import { z } from 'zod';

import { KafkaConnectionConfig, kafkaConnection, resolveConnection } from './connection.js';

export const KafkaSourceConfig = z.object({
  ...KafkaConnectionConfig.partial().shape,
  topics: z.array(z.string().regex(/^[\w.-]{1,249}$/)).min(1),
  groupId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Consumer group; defaults to cloud-trigger-<jobId>. Kafka balances partitions across replicas.',
    ),
  fromBeginning: z
    .boolean()
    .default(false)
    .describe('Start from the earliest offset when the group has no committed offset.'),
});

export const kafkaSource = defineInlineConnectedEventSource({
  type: 'kafka',
  displayName: 'Kafka topic',
  description:
    'Runs once per record. Offsets are committed only after the run is queued; the record offset is the deduplication id.',
  configSchema: KafkaSourceConfig,
  connection: kafkaConnection,
  exclusive: false,
  describe: (config) => `On Kafka record from ${config.topics.join(', ')}`,
  async subscribe(config, { signal, secrets, jobId, emit, connection }) {
    const options = await resolveConnection(connection.config, secrets);
    if (options.isErr()) {
      throw new Error(options.error.message);
    }
    const consumer = new Consumer({
      ...options.value,
      groupId: config.groupId ?? `cloud-trigger-${jobId}`,
      deserializers: stringDeserializers,
      autocommit: false,
    });
    try {
      const stream = await consumer.consume({
        topics: config.topics,
        mode: 'committed',
        fallbackMode: config.fromBeginning ? 'earliest' : 'latest',
      });
      const closeStream = () => {
        stream.close().catch(() => undefined);
      };
      if (signal.aborted) {
        closeStream();
      }
      signal.addEventListener('abort', closeStream, { once: true });
      try {
        for await (const message of stream) {
          await emit({
            id: `${message.topic}:${message.partition}:${message.offset}`,
            body: message.value ?? '',
            headers: Object.fromEntries(
              [...message.headers.entries()].map(([key, value]) => [key, value ?? '']),
            ),
          });
          await message.commit();
        }
      } finally {
        signal.removeEventListener('abort', closeStream);
      }
    } finally {
      await consumer.close(true);
    }
  },
});
