import { createHash } from 'node:crypto';

import {
  type Payload,
  ResultAsync,
  type RunContext,
  type SecretResolver,
  type TargetResult,
  abortedResult,
  failedResult,
  okAsync,
  secret,
  toError,
} from '@cloud-trigger/core';
import { interpolate, renderWithSecrets, templateScope } from '@cloud-trigger/providers-builtin';
import { z } from 'zod';

export const AwsConnection = {
  region: z.string().min(1).default('us-east-1'),
  endpoint: z
    .url()
    .optional()
    .describe('Custom endpoint, e.g. http://localhost:4566 for LocalStack.'),
  accessKeyId: secret(z.string().min(1))
    .optional()
    .describe('Static credentials. Leave empty to use the default AWS credential chain.'),
  secretAccessKey: secret(z.string().min(1)).optional(),
  sessionToken: secret(z.string().min(1)).optional(),
};

export const hasPairedCredentials = (config: {
  readonly accessKeyId?: string | undefined;
  readonly secretAccessKey?: string | undefined;
}) => (config.accessKeyId === undefined) === (config.secretAccessKey === undefined);
export const PAIRED_CREDENTIALS = {
  message: 'Set both accessKeyId and secretAccessKey, or neither',
  path: ['secretAccessKey'],
};

export const AwsConnectionConfig = z
  .object(AwsConnection)
  .refine(hasPairedCredentials, PAIRED_CREDENTIALS);
export type AwsConnection = z.output<typeof AwsConnectionConfig>;

export interface AwsClientConfig {
  readonly region: string;
  readonly endpoint?: string;
  readonly maxAttempts: number;
  readonly credentials?: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken?: string;
  };
}

const optional = (secrets: SecretResolver, value: string | undefined) =>
  value === undefined ? okAsync(undefined) : interpolate(secrets, value);

export const resolveClientConfig = (config: AwsConnection, secrets: SecretResolver) =>
  ResultAsync.combine([
    optional(secrets, config.accessKeyId),
    optional(secrets, config.secretAccessKey),
    optional(secrets, config.sessionToken),
  ] as const).map(([accessKeyId, secretAccessKey, sessionToken]): AwsClientConfig => ({
    region: config.region,
    maxAttempts: 1,
    ...(config.endpoint !== undefined && { endpoint: config.endpoint }),
    ...(accessKeyId !== undefined &&
      secretAccessKey !== undefined && {
        credentials: {
          accessKeyId,
          secretAccessKey,
          ...(sessionToken !== undefined && { sessionToken }),
        },
      }),
  }));

export const clientCache = <C>(create: (config: AwsClientConfig) => C) => {
  const clients = new Map<string, C>();

  return (config: AwsClientConfig): C => {
    const key = createHash('sha256').update(JSON.stringify(config)).digest('hex');
    const existing = clients.get(key);
    if (existing) {
      return existing;
    }
    const client = create(config);
    clients.set(key, client);

    return client;
  };
};

const AwsError = z.looseObject({
  name: z.string().default('Error'),
  message: z.string().default(''),
  $retryable: z.looseObject({}).optional(),
  $fault: z.enum(['client', 'server']).optional(),
  $metadata: z.looseObject({ httpStatusCode: z.number().optional() }).optional(),
});

const THROTTLING = new Set([
  'ThrottlingException',
  'Throttling',
  'TooManyRequestsException',
  'RequestThrottled',
  'RequestLimitExceeded',
  'KMSThrottlingException',
  'InternalFailure',
  'InternalError',
  'ServiceUnavailable',
]);

export function awsFailure(
  error: unknown,
  signal: AbortSignal,
  durationMs: number,
  prefix: string,
): TargetResult {
  if (signal.aborted) {
    return abortedResult(signal, durationMs);
  }
  const parsed = AwsError.safeParse(error);
  if (!parsed.success) {
    return failedResult(`${prefix}_error`, toError(error).message, true, durationMs);
  }
  const status = parsed.data.$metadata?.httpStatusCode;
  const retryable =
    parsed.data.$retryable !== undefined ||
    parsed.data.$fault === 'server' ||
    THROTTLING.has(parsed.data.name) ||
    status === undefined ||
    status === 429 ||
    status >= 500;
  const result = failedResult(
    `${prefix}_${parsed.data.name}`,
    parsed.data.message || parsed.data.name,
    retryable,
    durationMs,
  );

  return status === undefined ? result : { ...result, statusCode: status };
}

export const messageBody = (payload: Payload, ctx: RunContext): string =>
  payload.body !== undefined && payload.body !== ''
    ? payload.body
    : JSON.stringify({
        runId: ctx.runId,
        jobId: ctx.jobId,
        jobName: ctx.jobName,
        scheduledAt: ctx.scheduledAt.toISOString(),
        attempt: ctx.attempt,
      });

const MAX_DEDUP_ID = 128;
export const dedupId = (key: string): string =>
  key.length <= MAX_DEDUP_ID && /^[\w!-/:-@[-`{-~]+$/.test(key)
    ? key
    : createHash('sha256').update(key).digest('hex');

export const renderOptional = (
  template: string | undefined,
  ctx: RunContext,
): ResultAsync<string | undefined, Error> =>
  template === undefined
    ? okAsync(undefined)
    : ResultAsync.fromPromise(
        renderWithSecrets(template, templateScope(ctx), ctx.secrets),
        toError,
      );

export const runAttributes = (ctx: RunContext): Record<string, string> => ({
  'x-cloud-trigger-run-id': ctx.runId,
  'x-cloud-trigger-attempt': String(ctx.attempt),
  ...(ctx.traceparent !== undefined && { traceparent: ctx.traceparent }),
});
