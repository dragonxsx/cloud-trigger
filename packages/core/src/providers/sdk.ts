import { err, ok, type Result } from 'neverthrow';
import { z } from 'zod';

import {
  type ConnectionCatalog,
  type ConnectionRef,
  emptyConnectionCatalog,
} from '../domain/connection.js';
import type { RunLifecycleEvent } from '../domain/notification.js';
import type { RunEvent, RunReason } from '../domain/run.js';
import type { TargetResult } from '../domain/target-result.js';
import type { SecretResolver } from '../ports/secrets.js';
import { type ConfigError, type ConfigIssue, configErrorFromZod } from '../shared/errors.js';
import { isRecord } from '../shared/guards.js';

export const ProviderKind = z.enum(['trigger', 'input', 'target', 'notifier', 'connection']);
export type ProviderKind = z.output<typeof ProviderKind>;
export type JsonSchema = z.core.JSONSchema.BaseSchema;

export const secret = <S extends z.ZodType>(schema: S): S => schema.meta({ secret: true });

export interface Payload {
  readonly body: string | undefined;
  readonly contentType: string | undefined;
  readonly attributes: Readonly<Record<string, string>>;
}

export const emptyPayload: Payload = { body: undefined, contentType: undefined, attributes: {} };

export interface ParentRun {
  readonly runId: string;
  readonly jobId: string;
  readonly jobName: string;
  readonly status: string;
  readonly result: TargetResult | null;
}

export interface RunContext {
  readonly parent?: ParentRun | undefined;
  readonly runId: string;
  readonly jobId: string;
  readonly jobName: string;
  readonly attempt: number;
  readonly scheduledAt: Date;
  readonly reason: RunReason;
  readonly secrets: SecretResolver;
  readonly now: Date;
  readonly traceparent?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly trigger?: { readonly event: RunEvent } | undefined;
}

export const deliveryKey = (ctx: RunContext): string => ctx.idempotencyKey ?? ctx.runId;

export const LintIssue = z.object({
  severity: z.enum(['info', 'warning', 'error']),
  message: z.string(),
});
export type LintIssue = z.output<typeof LintIssue>;

export const SchedulePreview = z.object({
  description: z.string(),
  nextFireTimes: z.array(z.date()),
  lint: z.array(LintIssue),
});
export type SchedulePreview = z.output<typeof SchedulePreview>;

export interface LintContext {
  readonly now: Date;
}

export interface TriggerContext {
  readonly after: Date;
  readonly lastFiredAt: Date | null;
  readonly fireCount: number;
  readonly jobId: string;
}

export interface TargetRequest {
  readonly payload: Payload;
  readonly ctx: RunContext;
  readonly signal: AbortSignal;
}

export type TriggerEvent =
  | {
      readonly kind: 'run_finished';
      readonly jobId: string;
      readonly runId: string;
      readonly status: 'succeeded' | 'failed' | 'timed_out';
    }
  | { readonly kind: 'webhook' | 'message'; readonly event: RunEvent };

export interface InboundRequest {
  readonly token: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly receivedAt: Date;
}

export type InboundVerdict =
  | {
      readonly accepted: true;
      readonly deliveryId: string;
      readonly perSecond?: number | undefined;
    }
  | { readonly accepted: false; readonly reason: 'unauthorized' | 'invalid_signature' };

export interface InboundContext {
  readonly secrets: SecretResolver;
  readonly now: Date;
}

export interface SourceMessage {
  readonly id: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface SubscribeContext {
  readonly signal: AbortSignal;
  readonly secrets: SecretResolver;
  readonly jobId: string;
  readonly emit: (message: SourceMessage) => Promise<void>;
}

export interface BoundEventSource {
  readonly exclusive: boolean;
  subscribe(ctx: SubscribeContext): Promise<void>;
}

export interface UpstreamRef {
  readonly jobId: string;
  readonly path: string;
}

export interface BoundTrigger {
  nextFireAt(ctx: TriggerContext): Date | null;
  describe(): string;
  lint(ctx: LintContext): readonly LintIssue[];
  matches?(event: TriggerEvent): boolean;
  upstream?(): readonly UpstreamRef[];
  inbound?(request: InboundRequest, ctx: InboundContext): Promise<InboundVerdict>;
  readonly source?: BoundEventSource | undefined;
}
export interface BoundInput {
  resolve(ctx: RunContext): Promise<Payload>;
}
export interface BoundTarget {
  execute(request: TargetRequest): Promise<TargetResult>;
}
export interface NotifyFailure {
  readonly message: string;
  readonly retryable: boolean;
}
export type NotifyResult = Result<void, NotifyFailure>;
export interface NotifyContext {
  readonly secrets: SecretResolver;
  readonly signal: AbortSignal;
  readonly now: Date;
}

export interface BoundNotifier {
  notify(event: RunLifecycleEvent, ctx: NotifyContext): Promise<NotifyResult>;
}

export interface ConnectionTestContext {
  readonly secrets: SecretResolver;
  readonly signal: AbortSignal;
  readonly now: Date;
}
export interface ConnectionTestFailure {
  readonly message: string;
}
export type ConnectionTestResult = Result<{ readonly message: string }, ConnectionTestFailure>;

export interface BoundConnection {
  test(ctx: ConnectionTestContext): Promise<ConnectionTestResult>;
}

export interface BoundByKind {
  trigger: BoundTrigger;
  input: BoundInput;
  target: BoundTarget;
  notifier: BoundNotifier;
  connection: BoundConnection;
}

export interface ConnectionBinding {
  readonly key: string;
  readonly version: number;
  readonly config: unknown;
}

export interface Connected<C> {
  readonly key: string;
  readonly version: number;
  readonly config: C;
}

export interface BindEnv {
  readonly connection?: ConnectionBinding | undefined;
  readonly connections?: ConnectionCatalog | undefined;
}

export const BASE_URL_OPTION = '@baseUrl';

export interface ExtractOptions {
  readonly baseUrl?: string | undefined;
}

export interface ConnectionSplit {
  readonly connection: Readonly<Record<string, unknown>>;
  readonly config: Readonly<Record<string, unknown>>;
  readonly suggestedName?: string | undefined;
  readonly warnings?: readonly ConfigIssue[] | undefined;
}

export interface ExtractedConnection {
  readonly connection: Readonly<Record<string, unknown>>;
  readonly config: Readonly<Record<string, unknown>>;
  readonly suggestedName: string | undefined;
  readonly warnings: readonly ConfigIssue[];
}

export type ConnectionExtractor = (
  rawConfig: unknown,
  options: ExtractOptions,
) => Result<ExtractedConnection, ConfigError>;

type SplitConnection<S extends z.ZodType> = (
  config: z.output<S>,
  raw: Readonly<Record<string, unknown>>,
  options: ExtractOptions,
) => Result<ConnectionSplit, readonly ConfigIssue[]>;

export interface Provider<K extends ProviderKind = ProviderKind> {
  readonly kind: K;
  readonly type: string;
  readonly displayName: string;
  readonly description: string;
  readonly connectionType?: string | undefined;
  readonly connectionRequired?: boolean | undefined;
  readonly connectionFields?: readonly string[] | undefined;
  jsonSchema(): JsonSchema;
  bind(rawConfig: unknown, env?: BindEnv): Result<BoundByKind[K], ConfigError>;
  connectionRefs?(rawConfig: unknown): readonly ConnectionRef[];
  readonly extractConnection?: ConnectionExtractor | undefined;
  readonly address?: ((rawConfig: unknown) => string | undefined) | undefined;
}

export type TriggerProvider = Provider<'trigger'>;
export type InputProvider = Provider<'input'>;
export type TargetProvider = Provider<'target'>;
export type NotifierProvider = Provider<'notifier'>;
export interface ConnectionProvider<
  S extends z.ZodType = z.ZodType,
> extends Provider<'connection'> {
  readonly configSchema: S;
}
export type AnyProvider =
  | TriggerProvider
  | InputProvider
  | TargetProvider
  | NotifierProvider
  | ConnectionProvider;

interface BaseDefinition<S extends z.ZodType> {
  readonly type: string;
  readonly displayName: string;
  readonly description?: string;
  readonly configSchema: S;
}

export interface TriggerDefinition<S extends z.ZodType> extends BaseDefinition<S> {
  nextFireAt(config: z.output<S>, ctx: TriggerContext): Date | null;
  describe(config: z.output<S>): string;
  lint?(config: z.output<S>, ctx: LintContext): readonly LintIssue[];
}
export interface EventTriggerDefinition<S extends z.ZodType> extends BaseDefinition<S> {
  matches(config: z.output<S>, event: TriggerEvent): boolean;
  upstream(config: z.output<S>): readonly UpstreamRef[];
  describe(config: z.output<S>): string;
  lint?(config: z.output<S>, ctx: LintContext): readonly LintIssue[];
  inbound?(
    config: z.output<S>,
    request: InboundRequest,
    ctx: InboundContext,
  ): Promise<InboundVerdict>;
}
export interface EventSourceDefinition<S extends z.ZodType> extends BaseDefinition<S> {
  readonly exclusive: boolean;
  subscribe(config: z.output<S>, ctx: SubscribeContext): Promise<void>;
  describe(config: z.output<S>): string;
  lint?(config: z.output<S>, ctx: LintContext): readonly LintIssue[];
}
export interface ConnectedSubscribeContext<C> extends SubscribeContext {
  readonly connection: Connected<C>;
}
export interface InlineConnectedEventSourceDefinition<
  S extends z.ZodType,
  C extends z.ZodObject,
> extends BaseDefinition<S> {
  readonly connection: ConnectionProvider<C>;
  readonly exclusive: boolean;
  subscribe(config: z.output<S>, ctx: ConnectedSubscribeContext<z.output<C>>): Promise<void>;
  describe(config: z.output<S>): string;
  lint?(config: z.output<S>, ctx: LintContext): readonly LintIssue[];
}
export interface InputDefinition<S extends z.ZodType> extends BaseDefinition<S> {
  resolve(config: z.output<S>, ctx: RunContext): Promise<Payload>;
}

export interface TargetExecution extends TargetRequest {
  readonly connections: ConnectionCatalog;
}
export interface TargetDefinition<S extends z.ZodType> extends BaseDefinition<S> {
  execute(config: z.output<S>, request: TargetExecution): Promise<TargetResult>;
  check?(
    config: z.output<S>,
    env: { readonly connections: ConnectionCatalog },
  ): readonly ConfigIssue[];
  readonly connectionRefs?: (config: z.output<S>) => readonly ConnectionRef[];
}

export interface ConnectedTargetExecution<C> extends TargetExecution {
  readonly connection: Connected<C> | undefined;
}
export interface ConnectedTargetDefinition<
  S extends z.ZodType,
  C extends z.ZodType,
> extends BaseDefinition<S> {
  readonly connection: ConnectionProvider<C>;
  readonly connectionRequired?: boolean;
  execute(
    config: z.output<S>,
    request: ConnectedTargetExecution<z.output<C>>,
  ): Promise<TargetResult>;
  check?(
    config: z.output<S>,
    connection: Connected<z.output<C>> | undefined,
  ): readonly ConfigIssue[];
  readonly extractConnection?: SplitConnection<S>;
}

export interface InlineConnectedTargetExecution<C> extends TargetExecution {
  readonly connection: Connected<C>;
}
export interface InlineConnectedTargetDefinition<
  S extends z.ZodType,
  C extends z.ZodObject,
> extends BaseDefinition<S> {
  readonly connection: ConnectionProvider<C>;
  execute(
    config: z.output<S>,
    request: InlineConnectedTargetExecution<z.output<C>>,
  ): Promise<TargetResult>;
}

export interface NotifierDefinition<S extends z.ZodType> extends BaseDefinition<S> {
  notify(config: z.output<S>, event: RunLifecycleEvent, ctx: NotifyContext): Promise<NotifyResult>;
}

export interface ConnectedNotifyContext<C> extends NotifyContext {
  readonly connection: Connected<C> | undefined;
}
export interface ConnectedNotifierDefinition<
  S extends z.ZodType,
  C extends z.ZodType,
> extends BaseDefinition<S> {
  readonly connection: ConnectionProvider<C>;
  readonly connectionRequired?: boolean;
  notify(
    config: z.output<S>,
    event: RunLifecycleEvent,
    ctx: ConnectedNotifyContext<z.output<C>>,
  ): Promise<NotifyResult>;
  check?(
    config: z.output<S>,
    connection: Connected<z.output<C>> | undefined,
  ): readonly ConfigIssue[];
  readonly extractConnection?: SplitConnection<S>;
}

export interface InlineConnectedNotifyContext<C> extends NotifyContext {
  readonly connection: Connected<C>;
}
export interface InlineConnectedNotifierDefinition<
  S extends z.ZodType,
  C extends z.ZodObject,
> extends BaseDefinition<S> {
  readonly connection: ConnectionProvider<C>;
  notify(
    config: z.output<S>,
    event: RunLifecycleEvent,
    ctx: InlineConnectedNotifyContext<z.output<C>>,
  ): Promise<NotifyResult>;
}
export interface ConnectionDefinition<S extends z.ZodType> extends BaseDefinition<S> {
  test?(config: z.output<S>, ctx: ConnectionTestContext): Promise<ConnectionTestResult>;
  readonly address?: (config: z.output<S>) => string;
}

const invalid = (subject: string, issues: readonly ConfigIssue[]): ConfigError => ({
  code: 'invalid_config',
  message: `Invalid configuration for ${subject}`,
  issues,
});

function extractor<S extends z.ZodType>(
  subject: string,
  schema: S,
  split: SplitConnection<S>,
): ConnectionExtractor {
  return (rawConfig, options) => {
    const parsed = schema.safeParse(rawConfig);
    if (!parsed.success) {
      return err(configErrorFromZod(parsed.error, subject));
    }

    return split(parsed.data, isRecord(rawConfig) ? rawConfig : {}, options)
      .map((s) => ({
        connection: s.connection,
        config: s.config,
        suggestedName: s.suggestedName,
        warnings: s.warnings ?? [],
      }))
      .mapErr((issues) => invalid(subject, issues));
  };
}

function makeProvider<K extends ProviderKind, S extends z.ZodType>(
  kind: K,
  def: BaseDefinition<S>,
  bindParsed: (
    config: z.output<S>,
    env: BindEnv,
    rawConfig: unknown,
  ) => Result<BoundByKind[K], ConfigError>,
  connection?: {
    readonly type: string;
    readonly required: boolean;
    readonly fields?: readonly string[];
    readonly split?: SplitConnection<S> | undefined;
  },
): Provider<K> {
  const subject = `${kind} "${def.type}"`;

  return {
    kind,
    type: def.type,
    displayName: def.displayName,
    description: def.description ?? '',
    ...(connection && { connectionType: connection.type, connectionRequired: connection.required }),
    ...(connection?.fields && { connectionFields: connection.fields }),
    ...(connection?.split && {
      extractConnection: extractor(subject, def.configSchema, connection.split),
    }),
    jsonSchema: () => z.toJSONSchema(def.configSchema, { io: 'input', unrepresentable: 'any' }),
    bind(rawConfig, env = {}) {
      if (env.connection && !connection) {
        return err(
          invalid(subject, [{ path: '', message: `${subject} does not use connections` }]),
        );
      }
      const parsed = def.configSchema.safeParse(rawConfig);

      return parsed.success
        ? bindParsed(parsed.data, env, rawConfig)
        : err(configErrorFromZod(parsed.error, subject));
    },
  };
}

export const defineTrigger = <S extends z.ZodType>(def: TriggerDefinition<S>): TriggerProvider =>
  makeProvider('trigger', def, (config) =>
    ok({
      nextFireAt: (ctx) => def.nextFireAt(config, ctx),
      describe: () => def.describe(config),
      lint: (ctx) => def.lint?.(config, ctx) ?? [],
    }),
  );

export const defineEventTrigger = <S extends z.ZodType>(
  def: EventTriggerDefinition<S>,
): TriggerProvider =>
  makeProvider('trigger', def, (config) =>
    ok({
      nextFireAt: () => null,
      describe: () => def.describe(config),
      lint: (ctx) => def.lint?.(config, ctx) ?? [],
      matches: (event) => def.matches(config, event),
      upstream: () => def.upstream(config),
      ...(def.inbound && {
        inbound: (request: InboundRequest, ctx: InboundContext) =>
          def.inbound?.(config, request, ctx) ??
          Promise.resolve<InboundVerdict>({ accepted: false, reason: 'unauthorized' }),
      }),
    }),
  );

const sourceTrigger = <S extends z.ZodType>(
  def: Pick<EventSourceDefinition<S>, 'type' | 'describe' | 'lint'>,
  config: z.output<S>,
): BoundTrigger => ({
  nextFireAt: () => null,
  describe: () => def.describe(config),
  lint: (ctx) => def.lint?.(config, ctx) ?? [],
  matches: (event) => event.kind === 'message' && event.event.source === def.type,
  upstream: () => [],
});

export const defineEventSource = <S extends z.ZodType>(
  def: EventSourceDefinition<S>,
): TriggerProvider =>
  makeProvider('trigger', def, (config) =>
    ok({
      ...sourceTrigger(def, config),
      source: {
        exclusive: def.exclusive,
        subscribe: (ctx) => def.subscribe(config, ctx),
      },
    }),
  );

export const defineInput = <S extends z.ZodType>(def: InputDefinition<S>): InputProvider =>
  makeProvider('input', def, (config) => ok({ resolve: (ctx) => def.resolve(config, ctx) }));

export function defineTarget<S extends z.ZodType>(def: TargetDefinition<S>): TargetProvider {
  const provider = makeProvider('target', def, (config, env) => {
    const connections = env.connections ?? emptyConnectionCatalog;
    const issues = def.check?.(config, { connections }) ?? [];

    return issues.length > 0
      ? err(invalid(`target "${def.type}"`, issues))
      : ok({ execute: (request) => def.execute(config, { ...request, connections }) });
  });
  const { connectionRefs } = def;
  if (!connectionRefs) {
    return provider;
  }

  return {
    ...provider,
    connectionRefs: (rawConfig) => {
      const parsed = def.configSchema.safeParse(rawConfig);

      return parsed.success ? connectionRefs(parsed.data) : [];
    },
  };
}

function bindSeparateConnection<S extends z.ZodType, C extends z.ZodType>(
  def: {
    readonly connection: ConnectionProvider<C>;
    readonly connectionRequired?: boolean;
    check?(
      config: z.output<S>,
      connection: Connected<z.output<C>> | undefined,
    ): readonly ConfigIssue[];
  },
  config: z.output<S>,
  binding: ConnectionBinding | undefined,
  subject: string,
): Result<Connected<z.output<C>> | undefined, ConfigError> {
  if (!binding && def.connectionRequired === true) {
    return err(
      invalid(subject, [
        { path: '', message: `${subject} needs a "${def.connection.type}" connection` },
      ]),
    );
  }
  const parsed = binding ? def.connection.configSchema.safeParse(binding.config) : undefined;
  if (parsed && !parsed.success) {
    return err(configErrorFromZod(parsed.error, `connection "${binding?.key ?? ''}"`));
  }
  const connection: Connected<z.output<C>> | undefined =
    binding && parsed?.success
      ? { key: binding.key, version: binding.version, config: parsed.data }
      : undefined;
  const issues = def.check?.(config, connection) ?? [];

  return issues.length > 0 ? err(invalid(subject, issues)) : ok(connection);
}

export const defineConnectedTarget = <S extends z.ZodType, C extends z.ZodType>(
  def: ConnectedTargetDefinition<S, C>,
): TargetProvider =>
  makeProvider(
    'target',
    def,
    (config, env) => {
      const connections = env.connections ?? emptyConnectionCatalog;

      return bindSeparateConnection(def, config, env.connection, `target "${def.type}"`).map(
        (connection) => ({
          execute: (request) => def.execute(config, { ...request, connection, connections }),
        }),
      );
    },
    {
      type: def.connection.type,
      required: def.connectionRequired === true,
      split: def.extractConnection,
    },
  );

export const INLINE_CONNECTION_KEY = '';

function bindInlineConnection<C extends z.ZodObject>(
  provider: ConnectionProvider<C>,
  rawConfig: unknown,
  binding: ConnectionBinding | undefined,
  subject: string,
): Result<Connected<z.output<C>>, ConfigError> {
  const schema = provider.configSchema;
  const fields = Object.keys(schema.shape);
  const raw = isRecord(rawConfig) ? rawConfig : {};
  if (binding) {
    const doubled = fields.filter((field) => raw[field] !== undefined);
    if (doubled.length > 0) {
      return err(
        invalid(
          subject,
          doubled.map((field) => ({
            path: field,
            message: `Set on the "${binding.key}" connection instead`,
          })),
        ),
      );
    }
  }
  const source = binding
    ? binding.config
    : Object.fromEntries(fields.flatMap((field) => (field in raw ? [[field, raw[field]]] : [])));
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    return err(configErrorFromZod(parsed.error, binding ? `connection "${binding.key}"` : subject));
  }

  return ok({
    key: binding?.key ?? INLINE_CONNECTION_KEY,
    version: binding?.version ?? 0,
    config: parsed.data,
  });
}

const splitInline =
  (fields: readonly string[]) =>
  (
    _config: unknown,
    raw: Readonly<Record<string, unknown>>,
    options: ExtractOptions,
  ): Result<ConnectionSplit, readonly ConfigIssue[]> => {
    if (options.baseUrl !== undefined) {
      return err([{ path: BASE_URL_OPTION, message: 'Only HTTP connections take a base URL' }]);
    }
    const entries = Object.entries(raw);

    return ok({
      connection: Object.fromEntries(entries.filter(([field]) => fields.includes(field))),
      config: Object.fromEntries(entries.filter(([field]) => !fields.includes(field))),
    });
  };

const inlineConnection = <C extends z.ZodObject>(provider: ConnectionProvider<C>) => {
  const fields = Object.keys(provider.configSchema.shape);

  return { type: provider.type, required: false, fields, split: splitInline(fields) };
};

export const defineInlineConnectedTarget = <S extends z.ZodType, C extends z.ZodObject>(
  def: InlineConnectedTargetDefinition<S, C>,
): TargetProvider =>
  makeProvider(
    'target',
    def,
    (config, env, rawConfig) => {
      const connections = env.connections ?? emptyConnectionCatalog;

      return bindInlineConnection(
        def.connection,
        rawConfig,
        env.connection,
        `target "${def.type}"`,
      ).map((connection) => ({
        execute: (request) => def.execute(config, { ...request, connection, connections }),
      }));
    },
    inlineConnection(def.connection),
  );

export const defineInlineConnectedEventSource = <S extends z.ZodType, C extends z.ZodObject>(
  def: InlineConnectedEventSourceDefinition<S, C>,
): TriggerProvider =>
  makeProvider(
    'trigger',
    def,
    (config, env, rawConfig) =>
      bindInlineConnection(def.connection, rawConfig, env.connection, `trigger "${def.type}"`).map(
        (connection): BoundTrigger => ({
          ...sourceTrigger(def, config),
          source: {
            exclusive: def.exclusive,
            subscribe: (ctx) => def.subscribe(config, { ...ctx, connection }),
          },
        }),
      ),
    inlineConnection(def.connection),
  );

export const defineNotifier = <S extends z.ZodType>(def: NotifierDefinition<S>): NotifierProvider =>
  makeProvider('notifier', def, (config) =>
    ok({ notify: (event, ctx) => def.notify(config, event, ctx) }),
  );

export const defineConnectedNotifier = <S extends z.ZodType, C extends z.ZodType>(
  def: ConnectedNotifierDefinition<S, C>,
): NotifierProvider =>
  makeProvider(
    'notifier',
    def,
    (config, env) =>
      bindSeparateConnection(def, config, env.connection, `notifier "${def.type}"`).map(
        (connection) => ({
          notify: (event, ctx) => def.notify(config, event, { ...ctx, connection }),
        }),
      ),
    {
      type: def.connection.type,
      required: def.connectionRequired === true,
      split: def.extractConnection,
    },
  );

export const defineInlineConnectedNotifier = <S extends z.ZodType, C extends z.ZodObject>(
  def: InlineConnectedNotifierDefinition<S, C>,
): NotifierProvider =>
  makeProvider(
    'notifier',
    def,
    (config, env, rawConfig) =>
      bindInlineConnection(def.connection, rawConfig, env.connection, `notifier "${def.type}"`).map(
        (connection): BoundNotifier => ({
          notify: (event, ctx) => def.notify(config, event, { ...ctx, connection }),
        }),
      ),
    inlineConnection(def.connection),
  );

export const defineConnection = <S extends z.ZodType>(
  def: ConnectionDefinition<S>,
): ConnectionProvider<S> => {
  const { address } = def;

  return {
    ...makeProvider('connection', def, (config) =>
      ok({
        test: (ctx) =>
          def.test?.(config, ctx) ??
          Promise.resolve<ConnectionTestResult>(ok({ message: 'Configuration is valid' })),
      }),
    ),
    configSchema: def.configSchema,
    ...(address && {
      address: (rawConfig: unknown) => {
        const parsed = def.configSchema.safeParse(rawConfig);

        return parsed.success ? address(parsed.data) : undefined;
      },
    }),
  };
};
