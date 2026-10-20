import { defineInlineConnectedEventSource } from '@cloud-trigger/core';
import { AckPolicy, type JsMsg, jetstream, jetstreamManager } from '@nats-io/jetstream';
import { z } from 'zod';

import {
  NatsConnectionSettings,
  connectionFor,
  natsConnection,
  resolveConnection,
} from './nats-target.js';

export const NatsSourceConfig = z.object({
  ...NatsConnectionSettings.partial().shape,
  stream: z.string().min(1).describe('JetStream stream to consume from.'),
  durable: z
    .string()
    .regex(/^[\w-]+$/)
    .optional()
    .describe('Durable consumer name; defaults to cloud-trigger-<jobId>. Replicas share it.'),
  filterSubject: z.string().min(1).optional(),
  ackWaitMs: z
    .int()
    .min(1_000)
    .default(30_000)
    .describe('Redelivery delay when a run cannot be queued.'),
});

const headersOf = (message: JsMsg): Record<string, string> =>
  Object.fromEntries(
    (message.headers?.keys() ?? []).map((key) => [key, message.headers?.get(key) ?? '']),
  );

export const natsSource = defineInlineConnectedEventSource({
  type: 'nats',
  displayName: 'NATS JetStream',
  description:
    'Runs once per JetStream message through a durable consumer. Messages are acked after the run is queued; the stream sequence is the deduplication id.',
  configSchema: NatsSourceConfig,
  connection: natsConnection,
  exclusive: false,
  describe: (config) => `On JetStream message from ${config.stream}`,
  async subscribe(config, { signal, secrets, jobId, emit, connection }) {
    const resolved = await resolveConnection(connection.config, secrets);
    if (resolved.isErr()) {
      throw new Error(resolved.error.message);
    }
    const nc = await connectionFor(resolved.value);
    const durable = config.durable ?? `cloud-trigger-${jobId}`;
    const manager = await jetstreamManager(nc);
    await manager.consumers.add(config.stream, {
      durable_name: durable,
      ack_policy: AckPolicy.Explicit,
      ack_wait: config.ackWaitMs * 1_000_000,
      ...(config.filterSubject !== undefined && { filter_subject: config.filterSubject }),
    });
    const consumer = await jetstream(nc).consumers.get(config.stream, durable);
    const messages = await consumer.consume();
    const stop = () => messages.stop();
    if (signal.aborted) {
      stop();
    }
    signal.addEventListener('abort', stop, { once: true });
    try {
      for await (const message of messages) {
        try {
          await emit({
            id: `${config.stream}:${message.seq}`,
            body: message.string(),
            headers: headersOf(message),
          });
        } catch (error: unknown) {
          message.nak();
          throw error;
        }
        message.ack();
      }
    } finally {
      signal.removeEventListener('abort', stop);
      messages.stop();
    }
  },
});
