import {
  type ConfigIssue,
  type ConnectionCatalog,
  type FanoutChild,
  type JsonSchema,
  type ProviderRegistry,
  TargetConnectionRef,
  type TargetProvider,
  type TargetResult,
  abortedResult,
  defineTarget,
  resolveTarget,
} from '@cloud-trigger/core';
import pLimit from 'p-limit';
import { z } from 'zod';

export const FANOUT_TYPE = 'fanout';
const MAX_CHILDREN = 20;

const ChildRef = z.object({
  type: z.string().min(1),
  name: z.string().max(100).optional(),
  connection: TargetConnectionRef.optional(),
  config: z.unknown(),
});

const FanoutShape = z.object({
  targets: z.array(ChildRef).min(1).max(MAX_CHILDREN),
  mode: z
    .enum(['all', 'any'])
    .default('all')
    .describe('all: every target must succeed. any: one success is enough.'),
  parallelism: z.int().min(1).max(MAX_CHILDREN).default(4),
});
export type FanoutConfig = z.output<typeof FanoutShape>;

const childLabel = (child: FanoutChild) => child.name ?? `${child.type} #${child.index + 1}`;

export function aggregate(
  mode: FanoutConfig['mode'],
  children: readonly FanoutChild[],
  durationMs: number,
): TargetResult {
  const failed = children.filter((child) => child.outcome === 'failure');
  const ok = mode === 'all' ? failed.length === 0 : failed.length < children.length;
  const metadata = { mode, children };
  if (ok) {
    return { outcome: 'success', durationMs, metadata };
  }

  return {
    outcome: 'failure',
    durationMs,
    metadata,
    error: {
      code: 'fanout_failed',
      message: `${failed.length} of ${children.length} targets failed: ${failed
        .map((child) => `${childLabel(child)} (${child.error?.code ?? 'failed'})`)
        .join(', ')}`,
      retryable: failed.every((child) => child.error?.retryable === true),
    },
  };
}

const childSchemas = (registry: ProviderRegistry): JsonSchema[] =>
  registry
    .providers('target')
    .filter((provider) => provider.type !== FANOUT_TYPE)
    .map((provider) => ({
      type: 'object',
      title: provider.displayName,
      properties: {
        type: { type: 'string', const: provider.type, default: provider.type },
        name: { type: 'string', maxLength: 100, description: 'Label shown in run details.' },
        ...(provider.connectionType !== undefined && {
          connection: z.toJSONSchema(TargetConnectionRef, { io: 'input' }),
        }),
        config: provider.jsonSchema(),
      },
      required: ['type', 'config'],
    }));

function childIssues(
  registry: ProviderRegistry,
  config: FanoutConfig,
  connections: ConnectionCatalog,
): ConfigIssue[] {
  return config.targets.flatMap((child, index) => {
    if (child.type === FANOUT_TYPE) {
      return [{ path: `targets.${index}.type`, message: 'Fan-out targets cannot be nested' }];
    }
    const resolved = resolveTarget(registry, child, connections);

    return resolved.isOk()
      ? []
      : resolved.error.issues.map((issue) => ({
          path: `targets.${index}.${issue.path}`,
          message: issue.message,
        }));
  });
}

export function createFanoutTarget(registry: ProviderRegistry): TargetProvider {
  const provider = defineTarget({
    type: FANOUT_TYPE,
    displayName: 'Fan-out',
    description: 'Sends the payload to several targets in parallel and records each result.',
    configSchema: FanoutShape,
    check: (config, { connections }) => childIssues(registry, config, connections),
    connectionRefs: (config) => config.targets.flatMap((child) => child.connection ?? []),
    async execute(config, { payload, ctx, signal, connections }) {
      const started = performance.now();
      const limit = pLimit(config.parallelism);
      const children = await Promise.all(
        config.targets.map((child, index) =>
          limit(async (): Promise<FanoutChild> => {
            const childStarted = performance.now();
            const base = {
              index,
              type: child.type,
              ...(child.name !== undefined && { name: child.name }),
            };
            const bound = resolveTarget(registry, child, connections);
            if (bound.isErr()) {
              return {
                ...base,
                outcome: 'failure',
                durationMs: 0,
                error: { code: 'invalid_config', message: bound.error.message, retryable: false },
              };
            }
            const result = await bound.value.target
              .execute({
                payload,
                ctx: {
                  ...ctx,
                  idempotencyKey: `${ctx.idempotencyKey ?? ctx.runId}:fanout:${index}`,
                },
                signal,
              })
              .catch((error: unknown) => ({
                outcome: 'failure' as const,
                durationMs: performance.now() - childStarted,
                error: { code: 'unexpected', message: String(error), retryable: true },
              }));

            return {
              ...base,
              outcome: result.outcome,
              durationMs: result.durationMs,
              ...('statusCode' in result &&
                result.statusCode !== undefined && { statusCode: result.statusCode }),
              ...(result.error && { error: result.error }),
            };
          }),
        ),
      );

      const durationMs = performance.now() - started;
      if (signal.aborted) {
        return { ...abortedResult(signal, durationMs), metadata: { mode: config.mode, children } };
      }

      return aggregate(config.mode, children, durationMs);
    },
  });

  return {
    ...provider,
    jsonSchema: (): JsonSchema => {
      const schema = provider.jsonSchema();
      const targets = schema.properties?.['targets'];

      return typeof targets === 'object'
        ? {
            ...schema,
            properties: {
              ...schema.properties,
              targets: { ...targets, items: { anyOf: childSchemas(registry) } },
            },
          }
        : schema;
    },
  };
}
