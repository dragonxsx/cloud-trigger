import { createHash } from 'node:crypto';

import {
  type ConnectionTestResult,
  ResultAsync,
  type SecretResolver,
  type TargetResult,
  abortable,
  abortedResult,
  defineConnection,
  err,
  failedResult,
  ok,
  okAsync,
  secret,
  toError,
} from '@cloud-trigger/core';
import { interpolate } from '@cloud-trigger/providers-builtin';
import { Admin, GenericError, type ProducerOptions, findErrorBy } from '@platformatic/kafka';
import { z } from 'zod';

export const KafkaConnection = {
  brokers: z
    .array(z.string().regex(/^[^\s:]+:\d+$/, 'Use host:port'))
    .min(1)
    .describe('Bootstrap brokers as host:port.'),
  clientId: z.string().min(1).default('cloud-trigger'),
  sasl: z
    .object({
      mechanism: z.enum(['PLAIN', 'SCRAM-SHA-256', 'SCRAM-SHA-512']),
      username: z.string().min(1),
      password: secret(z.string().min(1)).describe('May contain {{secret:NAME}}.'),
    })
    .optional(),
  tls: z
    .object({
      enabled: z.boolean().default(false),
      ca: z.string().optional().describe('PEM CA bundle; system roots when empty.'),
      cert: z.string().optional().describe('PEM client certificate for mutual TLS.'),
      key: secret(z.string()).optional().describe('PEM client key for mutual TLS.'),
      rejectUnauthorized: z.boolean().default(true),
    })
    .prefault({}),
  timeoutMs: z.int().positive().default(10_000).describe('Connect and request timeout.'),
};

export const KafkaConnectionConfig = z.object(KafkaConnection);
export type KafkaConnection = z.output<typeof KafkaConnectionConfig>;

export const kafkaConnection = defineConnection({
  type: 'kafka',
  displayName: 'Kafka cluster',
  description: 'Brokers, SASL and TLS shared by Kafka targets.',
  configSchema: KafkaConnectionConfig,
  async test(config, { secrets, signal }): Promise<ConnectionTestResult> {
    const options = await resolveConnection(config, secrets);
    if (options.isErr()) {
      return err({ message: options.error.message });
    }
    const admin = new Admin(options.value);
    try {
      const topics = await abortable(signal, admin.listTopics());

      return ok({ message: `Connected; ${topics.length} topics visible` });
    } catch (error: unknown) {
      return err({ message: toError(error).message });
    } finally {
      await admin.close().catch(() => undefined);
    }
  },
});

export type KafkaClientOptions = Pick<
  ProducerOptions<string, string, string, string>,
  'clientId' | 'bootstrapBrokers' | 'sasl' | 'tls' | 'connectTimeout' | 'requestTimeout' | 'timeout'
>;

const optional = (secrets: SecretResolver, value: string | undefined) =>
  value === undefined ? okAsync(undefined) : interpolate(secrets, value);

export const resolveConnection = (config: KafkaConnection, secrets: SecretResolver) =>
  ResultAsync.combine([
    optional(secrets, config.sasl?.password),
    optional(secrets, config.tls.key),
  ] as const).map(([password, key]): KafkaClientOptions => ({
    clientId: config.clientId,
    bootstrapBrokers: config.brokers,
    connectTimeout: config.timeoutMs,
    requestTimeout: config.timeoutMs,
    timeout: config.timeoutMs,
    ...(config.sasl &&
      password !== undefined && {
        sasl: {
          mechanism: config.sasl.mechanism,
          username: config.sasl.username,
          password,
        },
      }),
    ...(config.tls.enabled && {
      tls: {
        rejectUnauthorized: config.tls.rejectUnauthorized,
        ...(config.tls.ca !== undefined && { ca: config.tls.ca }),
        ...(config.tls.cert !== undefined && { cert: config.tls.cert }),
        ...(key !== undefined && { key }),
      },
    }),
  }));

export const optionsKey = (options: KafkaClientOptions): string =>
  createHash('sha256').update(JSON.stringify(options)).digest('hex');

const ProtocolErrorId = z.looseObject({ id: z.string().min(1) });

const NON_RETRYABLE_CODES = new Set([
  'PLT_KFK_AUTHENTICATION',
  'PLT_KFK_USER',
  'PLT_KFK_UNSUPPORTED',
]);

export function kafkaFailure(
  error: unknown,
  signal: AbortSignal,
  durationMs: number,
): TargetResult {
  if (signal.aborted) {
    return abortedResult(signal, durationMs);
  }
  const failure = toError(error);
  if (!GenericError.isGenericError(failure)) {
    return failedResult('kafka_error', failure.message, true, durationMs);
  }
  const permanent = findErrorBy(failure, 'canRetry', false);
  const retryable =
    !NON_RETRYABLE_CODES.has(failure.code) &&
    (permanent === null || findErrorBy(failure, 'canRetry', true) !== null);
  const detail = permanent ?? failure;
  const protocolId = ProtocolErrorId.safeParse(detail);
  const name = protocolId.success ? protocolId.data.id : detail.code.replace(/^PLT_KFK_/, '');

  return failedResult(`kafka_${name.toLowerCase()}`, detail.message, retryable, durationMs);
}
