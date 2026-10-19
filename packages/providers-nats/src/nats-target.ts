import { createHash } from 'node:crypto';

import {
  type ConnectionTestResult,
  ResultAsync,
  type SecretResolver,
  type TargetResult,
  abortable,
  assertNever,
  abortedResult,
  defineConnection,
  defineInlineConnectedTarget,
  deliveryKey,
  err,
  failedResult,
  ok,
  okAsync,
  secret,
  toError,
} from '@cloud-trigger/core';
import { interpolate } from '@cloud-trigger/providers-builtin';
import { JetStreamApiError, JetStreamError, jetstream } from '@nats-io/jetstream';
import {
  AuthorizationError,
  type NatsConnection,
  type NodeConnectionOptions,
  NoRespondersError,
  PermissionViolationError,
  connect,
  headers as natsHeaders,
  nkeyAuthenticator,
} from '@nats-io/transport-node';
import { z } from 'zod';

const NatsAuth = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }).meta({ title: 'None' }),
  z.object({ type: z.literal('token'), token: secret(z.string().min(1)) }).meta({ title: 'Token' }),
  z
    .object({
      type: z.literal('userpass'),
      user: z.string().min(1),
      pass: secret(z.string().min(1)),
    })
    .meta({ title: 'User and password' }),
  z
    .object({ type: z.literal('nkey'), seed: secret(z.string().min(1)) })
    .meta({ title: 'NKey seed' }),
]);
type NatsAuth = z.output<typeof NatsAuth>;

export const NatsConnectionFields = {
  servers: z
    .array(z.string().regex(/^(nats|tls):\/\/[^\s]+$|^[^\s:/]+:\d+$/, 'Use nats://host:port'))
    .min(1),
  auth: NatsAuth.prefault({ type: 'none' }).describe('Secret fields may contain {{secret:NAME}}.'),
  tls: z
    .object({
      enabled: z.boolean().default(false),
      ca: z.string().optional().describe('PEM CA bundle; system roots when empty.'),
    })
    .prefault({}),
  timeoutMs: z.int().positive().default(10_000).describe('Connect and publish-ack timeout.'),
};
export const NatsConnectionSettings = z.object(NatsConnectionFields);
export type NatsConnectionConfig = z.output<typeof NatsConnectionSettings>;

export const NatsTargetConfig = z.object({
  ...NatsConnectionSettings.partial().shape,
  subject: z
    .string()
    .regex(/^[^\s*>]+$/, 'A concrete subject without wildcards')
    .describe('Subject to publish to.'),
  mode: z
    .enum(['core', 'jetstream'])
    .default('jetstream')
    .describe('JetStream waits for a stream ack and deduplicates by the run idempotency key.'),
  headers: z.record(z.string(), z.string()).default({}),
});
export type NatsTargetConfig = z.output<typeof NatsTargetConfig>;

const secretOf = (auth: NatsAuth): string | undefined => {
  switch (auth.type) {
    case 'none':
      return undefined;
    case 'token':
      return auth.token;
    case 'userpass':
      return auth.pass;
    case 'nkey':
      return auth.seed;
    default:
      return assertNever(auth);
  }
};

export interface ResolvedConnection {
  readonly key: string;
  readonly options: NodeConnectionOptions;
}

export const resolveConnection = (config: NatsConnectionConfig, secrets: SecretResolver) => {
  const raw = secretOf(config.auth);

  return (raw === undefined ? okAsync(undefined) : interpolate(secrets, raw)).map(
    (resolved): ResolvedConnection => ({
      key: createHash('sha256')
        .update(JSON.stringify({ config, resolved: resolved ?? null }))
        .digest('hex'),
      options: connectOptions(config, resolved),
    }),
  );
};

const connectOptions = (
  config: NatsConnectionConfig,
  resolved: string | undefined,
): NodeConnectionOptions => ({
  servers: config.servers,
  timeout: config.timeoutMs,
  maxReconnectAttempts: -1,
  waitOnFirstConnect: false,
  name: 'cloud-trigger',
  ...(config.tls.enabled && {
    tls: config.tls.ca === undefined ? {} : { ca: config.tls.ca },
  }),
  ...(config.auth.type === 'token' && resolved !== undefined && { token: resolved }),
  ...(config.auth.type === 'userpass' &&
    resolved !== undefined && { user: config.auth.user, pass: resolved }),
  ...(config.auth.type === 'nkey' &&
    resolved !== undefined && {
      authenticator: nkeyAuthenticator(new TextEncoder().encode(resolved)),
    }),
});

const connections = new Map<string, Promise<NatsConnection>>();

export const connectionFor = ({ key, options }: ResolvedConnection): Promise<NatsConnection> => {
  const existing = connections.get(key);
  if (existing) {
    return existing;
  }
  const created = connect(options);
  connections.set(key, created);
  const forgetWhenClosed = async () => {
    await ResultAsync.fromPromise(
      created.then(async (nc) => nc.closed()),
      toError,
    );
    connections.delete(key);
  };
  void forgetWhenClosed();

  return created;
};

export const closeConnections = async (): Promise<void> => {
  const open = [...connections.values()];
  connections.clear();
  await Promise.allSettled(open.map(async (nc) => (await nc).drain()));
};

const PERMANENT_NAMES = new Set(['JetStreamNotEnabled', 'NoRespondersError']);

const causes = (error: unknown): unknown[] =>
  error instanceof Error && error.cause !== undefined ? [error, ...causes(error.cause)] : [error];

const isPermanent = (error: unknown): boolean =>
  causes(error).some(
    (cause) =>
      cause instanceof AuthorizationError ||
      cause instanceof PermissionViolationError ||
      cause instanceof NoRespondersError ||
      (cause instanceof Error && PERMANENT_NAMES.has(cause.name)) ||
      (cause instanceof JetStreamApiError && cause.status < 500),
  );

export function natsFailure(error: unknown, signal: AbortSignal, durationMs: number): TargetResult {
  if (signal.aborted) {
    return abortedResult(signal, durationMs);
  }
  const failure = toError(error);
  const name =
    failure instanceof JetStreamApiError || failure instanceof JetStreamError
      ? 'jetstream'
      : failure.name
          .replace(/Error$/, '')
          .replace(/([a-z])([A-Z])/g, '$1_$2')
          .toLowerCase() || 'error';

  return failedResult(`nats_${name}`, failure.message, !isPermanent(failure), durationMs);
}

export const natsConnection = defineConnection({
  type: 'nats',
  displayName: 'NATS servers',
  description: 'Servers, credentials and TLS shared by NATS targets.',
  configSchema: NatsConnectionSettings,
  async test(config, { secrets, signal }): Promise<ConnectionTestResult> {
    const resolved = await resolveConnection(config, secrets);
    if (resolved.isErr()) {
      return err({ message: resolved.error.message });
    }
    try {
      const nc = await abortable(
        signal,
        connect({ ...resolved.value.options, maxReconnectAttempts: 0, waitOnFirstConnect: false }),
      );
      try {
        await abortable(signal, nc.flush());

        return ok({ message: `Connected to ${nc.getServer()}` });
      } finally {
        await nc.close();
      }
    } catch (error: unknown) {
      return err({ message: toError(error).message });
    }
  },
});

export const natsTarget = defineInlineConnectedTarget({
  type: 'nats',
  displayName: 'NATS message',
  description: 'Publishes the payload to a NATS subject, optionally through JetStream.',
  configSchema: NatsTargetConfig,
  connection: natsConnection,
  async execute(config, { payload, ctx, signal, connection: settings }): Promise<TargetResult> {
    const started = performance.now();
    const elapsed = () => performance.now() - started;
    const connection = await resolveConnection(settings.config, ctx.secrets);
    if (connection.isErr()) {
      return failedResult('missing_secret', connection.error.message, false, elapsed());
    }
    const body = new TextEncoder().encode(payload.body ?? '');
    const headers = natsHeaders();
    for (const [key, value] of Object.entries({
      ...payload.attributes,
      'x-cloud-trigger-run-id': ctx.runId,
      'x-cloud-trigger-attempt': String(ctx.attempt),
      ...(ctx.traceparent !== undefined && { traceparent: ctx.traceparent }),
      ...config.headers,
    })) {
      headers.set(key, value);
    }

    try {
      const nc = await abortable(signal, connectionFor(connection.value));
      if (config.mode === 'core') {
        nc.publish(config.subject, body, { headers });
        await abortable(signal, nc.flush());

        return { outcome: 'success', durationMs: elapsed(), metadata: { subject: config.subject } };
      }
      const ack = await abortable(
        signal,
        jetstream(nc).publish(config.subject, body, {
          headers,
          msgID: deliveryKey(ctx),
          timeout: settings.config.timeoutMs,
        }),
      );

      return {
        outcome: 'success',
        durationMs: elapsed(),
        metadata: { stream: ack.stream, seq: ack.seq, duplicate: ack.duplicate },
      };
    } catch (error: unknown) {
      return natsFailure(error, signal, elapsed());
    }
  },
});
