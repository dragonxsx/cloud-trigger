import {
  BASE_URL_OPTION,
  type Connected,
  type ConnectionTestResult,
  Result,
  ResultAsync,
  err,
  ok,
  type TargetResult,
  abortable,
  abortedResult,
  defineConnectedTarget,
  defineConnection,
  failedResult,
  okAsync,
  secret,
  toError,
} from '@cloud-trigger/core';
import {
  JsonPathAssertion,
  interpolate,
  interpolateValues,
  jsonPathFailure,
} from '@cloud-trigger/providers-builtin';
import {
  type ChannelCredentials,
  Client,
  Metadata,
  type ServiceError,
  status,
  credentials as grpcCredentials,
} from '@grpc/grpc-js';
import { z } from 'zod';

import {
  type UnaryMethod,
  findMethod,
  inlineDefinition,
  reflectedDefinition,
} from './definitions.js';

const STATUS_NAMES = [
  'OK',
  'CANCELLED',
  'UNKNOWN',
  'INVALID_ARGUMENT',
  'DEADLINE_EXCEEDED',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'PERMISSION_DENIED',
  'RESOURCE_EXHAUSTED',
  'FAILED_PRECONDITION',
  'ABORTED',
  'OUT_OF_RANGE',
  'UNIMPLEMENTED',
  'INTERNAL',
  'UNAVAILABLE',
  'DATA_LOSS',
  'UNAUTHENTICATED',
] as const;
const GrpcStatusName = z.enum(STATUS_NAMES);
type GrpcStatusName = z.output<typeof GrpcStatusName>;

const statusName = (code: number): GrpcStatusName => STATUS_NAMES[code] ?? 'UNKNOWN';

const ProtoSource = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('inline'),
      proto: z
        .string()
        .min(1)
        .describe('The .proto file text. google/protobuf/* imports are resolved automatically.'),
    })
    .meta({ title: 'Inline .proto' }),
  z
    .object({ type: z.literal('reflection') })
    .meta({ title: 'Server reflection', description: 'Fetch the schema from the server.' }),
]);

const GrpcTls = z.object({
  enabled: z.boolean().default(false),
  ca: z.string().optional().describe('PEM CA bundle; system roots when empty.'),
  cert: z.string().optional().describe('PEM client certificate for mutual TLS.'),
  key: secret(z.string()).optional().describe('PEM client key for mutual TLS.'),
});
type GrpcTls = z.output<typeof GrpcTls>;

const PLAINTEXT: GrpcTls = { enabled: false };

const Address = z.string().min(1).describe('host:port of the gRPC server, without a scheme.');
const RequestMetadata = z
  .record(z.string(), z.string())
  .default({})
  .describe('Request metadata. Values may contain {{secret:NAME}}.');
const SecretMetadata = z
  .record(z.string(), secret(z.string()))
  .default({})
  .describe('Credential metadata such as authorization. Shown as *** and kept on edit.');

export const GrpcConnectionConfig = z.object({
  address: Address,
  tls: GrpcTls.prefault({}),
  metadata: RequestMetadata,
  secretMetadata: SecretMetadata,
});
export type GrpcConnectionConfig = z.output<typeof GrpcConnectionConfig>;

export const GrpcTargetConfig = z.object({
  address: Address.optional().describe(
    'host:port of the gRPC server, without a scheme. Comes from the connection when one is used.',
  ),
  service: z.string().min(1).describe('Fully qualified service name, e.g. acme.billing.Invoices.'),
  method: z.string().min(1),
  protoSource: ProtoSource.prefault({ type: 'reflection' }),
  request: z
    .string()
    .optional()
    .describe('JSON request message. Overrides the input payload body when set.'),
  tls: GrpcTls.optional().describe(
    'Plaintext when unset. Comes from the connection when one is used.',
  ),
  metadata: RequestMetadata.describe(
    'Request metadata, merged over the connection metadata. Values may contain {{secret:NAME}}.',
  ),
  secretMetadata: SecretMetadata,
  deadlineMs: z.int().positive().optional().describe('Per-call gRPC deadline.'),
  maxResponseBytes: z
    .int()
    .min(0)
    .max(1024 * 1024)
    .default(64 * 1024),
  retryOnCodes: z
    .array(GrpcStatusName)
    .default(['UNAVAILABLE', 'DEADLINE_EXCEEDED', 'RESOURCE_EXHAUSTED']),
  assertions: z
    .object({
      expectedCodes: z.array(GrpcStatusName).min(1).default(['OK']),
      jsonPath: JsonPathAssertion.optional(),
    })
    .prefault({}),
});
export type GrpcTargetConfig = z.output<typeof GrpcTargetConfig>;

const channelCredentials = (tls: GrpcTls, key: string | undefined): ChannelCredentials =>
  tls.enabled
    ? grpcCredentials.createSsl(
        tls.ca === undefined ? null : Buffer.from(tls.ca),
        key === undefined ? null : Buffer.from(key),
        tls.cert === undefined ? null : Buffer.from(tls.cert),
      )
    : grpcCredentials.createInsecure();

const parseJson = Result.fromThrowable(
  (text: string): unknown => JSON.parse(text),
  () => 'Request is not valid JSON',
);
const RequestMessage = z.record(z.string(), z.unknown());
const parseRequest = (text: string): Result<Record<string, unknown>, string> =>
  parseJson(text).andThen((value) => {
    const message = RequestMessage.safeParse(value);

    return message.success ? ok(message.data) : err('Request must be a JSON object');
  });

interface CallOutcome {
  readonly code: number;
  readonly details: string;
  readonly response: object | undefined;
}

const isServiceError = (error: unknown): error is ServiceError =>
  error instanceof Error && 'code' in error && typeof error.code === 'number';

function unaryCall(
  client: Client,
  method: UnaryMethod,
  message: object,
  metadata: Metadata,
  options: { deadline?: Date; signal: AbortSignal },
): Promise<CallOutcome> {
  return new Promise((resolve, reject) => {
    const call = client.makeUnaryRequest(
      method.path,
      method.requestSerialize,
      method.responseDeserialize,
      message,
      metadata,
      options.deadline === undefined ? {} : { deadline: options.deadline },
      (error, response) => {
        options.signal.removeEventListener('abort', cancel);
        if (error === null) {
          resolve({ code: status.OK, details: '', response });
        } else if (isServiceError(error)) {
          resolve({ code: error.code, details: error.details, response: undefined });
        } else {
          reject(toError(error));
        }
      },
    );
    const cancel = () => call.cancel();
    options.signal.addEventListener('abort', cancel, { once: true });
  });
}

const truncate = (text: string, limit: number) => {
  const bytes = Buffer.from(text, 'utf8');

  return {
    body: bytes.subarray(0, limit).toString('utf8'),
    sizeBytes: bytes.length,
    truncated: bytes.length > limit,
  };
};

const waitForReady = (client: Client, deadline: Date) =>
  new Promise<void>((resolve, reject) => {
    client.waitForReady(deadline, (error) => (error ? reject(error) : resolve()));
  });

export const grpcConnection = defineConnection({
  type: 'grpc',
  displayName: 'gRPC server',
  description: 'Address, TLS and metadata shared by gRPC targets.',
  configSchema: GrpcConnectionConfig,
  address: (config) => config.address,
  async test(config, { secrets, signal }): Promise<ConnectionTestResult> {
    const key =
      config.tls.key === undefined ? okAsync(undefined) : interpolate(secrets, config.tls.key);
    const resolvedKey = await key;
    if (resolvedKey.isErr()) {
      return err({ message: resolvedKey.error.message });
    }
    const client = new Client(config.address, channelCredentials(config.tls, resolvedKey.value));
    try {
      await abortable(signal, waitForReady(client, new Date(Date.now() + 10_000)));

      return ok({ message: `Connected to ${config.address}` });
    } catch (error: unknown) {
      return err({ message: toError(error).message });
    } finally {
      client.close();
    }
  },
});

const channelOf = (
  config: GrpcTargetConfig,
  connection: Connected<GrpcConnectionConfig> | undefined,
) =>
  connection
    ? {
        address: connection.config.address,
        tls: connection.config.tls,
        metadata: { ...connection.config.metadata, ...config.metadata },
        secretMetadata: { ...connection.config.secretMetadata, ...config.secretMetadata },
      }
    : {
        address: config.address ?? '',
        tls: config.tls ?? PLAINTEXT,
        metadata: config.metadata,
        secretMetadata: config.secretMetadata,
      };

const CHANNEL_FIELDS = new Set(['address', 'tls', 'secretMetadata']);

export const grpcTarget = defineConnectedTarget({
  type: 'grpc',
  displayName: 'gRPC call',
  description: 'Calls a unary gRPC method with a JSON request message.',
  configSchema: GrpcTargetConfig,
  connection: grpcConnection,
  check: (config, connection) => {
    if (!connection) {
      return config.address === undefined ? [{ path: 'address', message: 'Required' }] : [];
    }

    return (['address', 'tls'] as const).flatMap((field) =>
      config[field] === undefined
        ? []
        : [{ path: field, message: `Set on the "${connection.key}" connection instead` }],
    );
  },
  extractConnection: (config, raw, { baseUrl }) => {
    if (baseUrl !== undefined) {
      return err([{ path: BASE_URL_OPTION, message: 'Only HTTP connections take a base URL' }]);
    }
    if (config.address === undefined) {
      return err([{ path: 'address', message: 'Required' }]);
    }
    const rest = Object.entries(raw).filter(([field]) => !CHANNEL_FIELDS.has(field));

    return ok({
      connection: {
        address: config.address,
        ...(raw['tls'] !== undefined && { tls: raw['tls'] }),
        ...(Object.keys(config.secretMetadata).length > 0 && {
          secretMetadata: config.secretMetadata,
        }),
      },
      config: Object.fromEntries(rest),
      suggestedName: config.address.replace(/:\d+$/, ''),
    });
  },
  async execute(config, { payload, ctx, signal, connection }): Promise<TargetResult> {
    const started = performance.now();
    const elapsed = () => performance.now() - started;
    const channel = channelOf(config, connection);
    const resolved = await ResultAsync.combine([
      interpolateValues(ctx.secrets, channel.metadata),
      interpolateValues(ctx.secrets, channel.secretMetadata),
      channel.tls.key === undefined
        ? okAsync(undefined)
        : interpolate(ctx.secrets, channel.tls.key),
    ] as const);
    if (resolved.isErr()) {
      return failedResult('missing_secret', resolved.error.message, false, elapsed());
    }
    const [plainMetadata, secretMetadata, tlsKey] = resolved.value;

    const parsedRequest = parseRequest(config.request ?? payload.body ?? '{}');
    if (parsedRequest.isErr()) {
      return failedResult('invalid_request', parsedRequest.error, false, elapsed());
    }

    const credentials = channelCredentials(channel.tls, tlsKey);
    const deadline =
      config.deadlineMs === undefined ? undefined : new Date(Date.now() + config.deadlineMs);
    const metadata = new Metadata();
    for (const [key, value] of Object.entries({ ...plainMetadata, ...secretMetadata })) {
      metadata.set(key, value);
    }
    metadata.set('x-cloud-trigger-run-id', ctx.runId);
    metadata.set('x-cloud-trigger-attempt', String(ctx.attempt));
    if (ctx.traceparent !== undefined) {
      metadata.set('traceparent', ctx.traceparent);
    }

    const client = new Client(channel.address, credentials);
    try {
      const definition =
        config.protoSource.type === 'inline'
          ? inlineDefinition(config.protoSource.proto)
          : await reflectedDefinition(
              channel.address,
              credentials,
              config.service,
              deadline ?? new Date(Date.now() + 30_000),
            );
      const method = findMethod(definition, config.service, config.method);
      if (typeof method === 'string') {
        return failedResult('grpc_method_not_found', method, false, elapsed());
      }

      const outcome = await unaryCall(client, method, parsedRequest.value, metadata, {
        ...(deadline !== undefined && { deadline }),
        signal,
      });
      if (signal.aborted) {
        return abortedResult(signal, elapsed());
      }
      const code = statusName(outcome.code);
      const json = outcome.response === undefined ? undefined : JSON.stringify(outcome.response);
      const result = {
        durationMs: elapsed(),
        statusCode: outcome.code,
        ...(json !== undefined && { response: truncate(json, config.maxResponseBytes) }),
        metadata: { grpcStatus: code, ...(outcome.details && { details: outcome.details }) },
      };
      const failure = !config.assertions.expectedCodes.includes(code)
        ? `gRPC status ${code}${outcome.details ? `: ${outcome.details}` : ''}`
        : config.assertions.jsonPath && outcome.response !== undefined
          ? jsonPathFailure(config.assertions.jsonPath, outcome.response)
          : undefined;
      if (failure === undefined) {
        return { outcome: 'success', ...result };
      }

      return {
        outcome: 'failure',
        ...result,
        error: {
          code: code === 'OK' ? 'grpc_assertion' : `grpc_${code.toLowerCase()}`,
          message: failure,
          retryable: config.retryOnCodes.includes(code),
        },
      };
    } catch (error: unknown) {
      if (signal.aborted) {
        return abortedResult(signal, elapsed());
      }

      return failedResult('grpc_error', toError(error).message, true, elapsed());
    } finally {
      client.close();
    }
  },
});
