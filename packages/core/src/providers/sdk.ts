import { err, ok, type Result } from 'neverthrow';
import { z } from 'zod';

import type { NotificationEvent } from '../domain/job.js';
import type { RunReason } from '../domain/run.js';
import type { TargetResult } from '../domain/target-result.js';
import type { SecretResolver } from '../ports/secrets.js';
import { type ConfigError, configErrorFromZod } from '../shared/errors.js';

export const ProviderKind = z.enum(['trigger', 'input', 'target', 'notifier']);
export type ProviderKind = z.output<typeof ProviderKind>;
export type JsonSchema = z.core.JSONSchema.BaseSchema;

export const secret = <S extends z.ZodType>(schema: S): S => schema.meta({ secret: true });

export interface Payload {
  readonly body: string | undefined;
  readonly contentType: string | undefined;
  readonly attributes: Readonly<Record<string, string>>;
}

export const emptyPayload: Payload = { body: undefined, contentType: undefined, attributes: {} };

export interface RunContext {
  readonly runId: string;
  readonly jobId: string;
  readonly jobName: string;
  readonly attempt: number;
  readonly scheduledAt: Date;
  readonly reason: RunReason;
  readonly secrets: SecretResolver;
  readonly now: Date;
}

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

export interface RunLifecycleEvent {
  readonly event: NotificationEvent;
  readonly jobId: string;
  readonly jobName: string;
  readonly runId: string;
  readonly status: string;
  readonly attempt: number;
  readonly scheduledAt: Date;
  readonly result: TargetResult | null;
}

export interface BoundTrigger {
  nextFireAt(ctx: TriggerContext): Date | null;
  describe(): string;
  lint(ctx: LintContext): readonly LintIssue[];
}
export interface BoundInput {
  resolve(ctx: RunContext): Promise<Payload>;
}
export interface BoundTarget {
  execute(request: TargetRequest): Promise<TargetResult>;
}
export interface BoundNotifier {
  notify(
    event: RunLifecycleEvent,
    ctx: { secrets: SecretResolver; signal: AbortSignal },
  ): Promise<void>;
}

interface BoundByKind {
  trigger: BoundTrigger;
  input: BoundInput;
  target: BoundTarget;
  notifier: BoundNotifier;
}

export interface Provider<K extends ProviderKind = ProviderKind> {
  readonly kind: K;
  readonly type: string;
  readonly displayName: string;
  readonly description: string;
  jsonSchema(): JsonSchema;
  bind(rawConfig: unknown): Result<BoundByKind[K], ConfigError>;
}

export type TriggerProvider = Provider<'trigger'>;
export type InputProvider = Provider<'input'>;
export type TargetProvider = Provider<'target'>;
export type NotifierProvider = Provider<'notifier'>;
export type AnyProvider = TriggerProvider | InputProvider | TargetProvider | NotifierProvider;

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
export interface InputDefinition<S extends z.ZodType> extends BaseDefinition<S> {
  resolve(config: z.output<S>, ctx: RunContext): Promise<Payload>;
}
export interface TargetDefinition<S extends z.ZodType> extends BaseDefinition<S> {
  execute(config: z.output<S>, request: TargetRequest): Promise<TargetResult>;
}
export interface NotifierDefinition<S extends z.ZodType> extends BaseDefinition<S> {
  notify(
    config: z.output<S>,
    event: RunLifecycleEvent,
    ctx: { secrets: SecretResolver; signal: AbortSignal },
  ): Promise<void>;
}

function makeProvider<K extends ProviderKind, S extends z.ZodType>(
  kind: K,
  def: BaseDefinition<S>,
  bindParsed: (config: z.output<S>) => BoundByKind[K],
): Provider<K> {
  return {
    kind,
    type: def.type,
    displayName: def.displayName,
    description: def.description ?? '',
    jsonSchema: () => z.toJSONSchema(def.configSchema, { io: 'input', unrepresentable: 'any' }),
    bind(rawConfig) {
      const parsed = def.configSchema.safeParse(rawConfig);

      return parsed.success
        ? ok(bindParsed(parsed.data))
        : err(configErrorFromZod(parsed.error, `${kind} "${def.type}"`));
    },
  };
}

export const defineTrigger = <S extends z.ZodType>(def: TriggerDefinition<S>): TriggerProvider =>
  makeProvider('trigger', def, (config) => ({
    nextFireAt: (ctx) => def.nextFireAt(config, ctx),
    describe: () => def.describe(config),
    lint: (ctx) => def.lint?.(config, ctx) ?? [],
  }));

export const defineInput = <S extends z.ZodType>(def: InputDefinition<S>): InputProvider =>
  makeProvider('input', def, (config) => ({ resolve: (ctx) => def.resolve(config, ctx) }));

export const defineTarget = <S extends z.ZodType>(def: TargetDefinition<S>): TargetProvider =>
  makeProvider('target', def, (config) => ({ execute: (request) => def.execute(config, request) }));

export const defineNotifier = <S extends z.ZodType>(def: NotifierDefinition<S>): NotifierProvider =>
  makeProvider('notifier', def, (config) => ({
    notify: (event, ctx) => def.notify(config, event, ctx),
  }));
