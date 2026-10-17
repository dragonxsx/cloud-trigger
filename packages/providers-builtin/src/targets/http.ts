import { createHmac } from 'node:crypto';

import {
  ResultAsync,
  type SecretResolver,
  type TargetResult,
  abortedResult,
  defineTarget,
  failedResult,
  okAsync,
  secret,
  toError,
} from '@cloud-trigger/core';
import { Agent, type Dispatcher, interceptors, request } from 'undici';
import { z } from 'zod';

import {
  HttpAssertions,
  StatusPattern,
  firstFailedAssertion,
  matchesStatus,
} from './http-assertions.js';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

export const HttpTargetConfig = z.object({
  method: z.enum(METHODS).default('POST'),
  url: z
    .string()
    .regex(/^https?:\/\//, 'Must start with http:// or https://')
    .describe('May contain {{secret:NAME}} placeholders.'),
  headers: z
    .record(z.string(), z.string())
    .default({})
    .describe('Values may contain {{secret:NAME}}.'),
  secretHeaders: z
    .record(z.string(), secret(z.string()))
    .default({})
    .describe(
      'Credential headers such as Authorization. Shown as *** and kept on edit. Values may contain {{secret:NAME}}.',
    ),
  query: z.record(z.string(), z.string()).default({}),
  body: z.string().optional().describe('Overrides the input payload body when set.'),
  maxRedirects: z.int().min(0).max(20).default(5),
  maxResponseBytes: z
    .int()
    .min(0)
    .max(1024 * 1024)
    .default(64 * 1024)
    .describe('Captured response bytes, at most 1 MiB so the run record fits in the database.'),
  retryOnStatus: z.array(StatusPattern).default(['408', '429', '5xx']),
  assertions: HttpAssertions.prefault({}),
  signing: z
    .object({
      secret: secret(z.string().min(1)),
      header: z.string().default('X-Signature'),
      timestampHeader: z.string().default('X-Signature-Timestamp'),
    })
    .optional()
    .describe('HMAC-SHA256 over "<timestamp>.<body>".'),
});
export type HttpTargetConfig = z.output<typeof HttpTargetConfig>;

const agents = new Map<number, Dispatcher>();
const dispatcherFor = (maxRedirections: number): Dispatcher => {
  const existing = agents.get(maxRedirections);
  if (existing) {
    return existing;
  }
  const agent = new Agent().compose(interceptors.redirect({ maxRedirections }));
  agents.set(maxRedirections, agent);

  return agent;
};

const flattenHeaders = (
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers).flatMap(([k, v]) =>
      v === undefined ? [] : [[k, Array.isArray(v) ? v.join(', ') : v]],
    ),
  );

async function readLimited(body: AsyncIterable<unknown>, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    const room = limit - (size - buf.length);
    if (room > 0) {
      chunks.push(room >= buf.length ? buf : buf.subarray(0, room));
    }
    if (size > limit) {
      truncated = true;
    }
  }

  return { text: Buffer.concat(chunks).toString('utf8'), sizeBytes: size, truncated };
}

const errorCode = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;

const interpolate = (secrets: SecretResolver, text: string) =>
  new ResultAsync(secrets.interpolate(text));

const interpolateValues = (secrets: SecretResolver, values: Record<string, string>) =>
  ResultAsync.combine(
    Object.entries(values).map(([key, value]) =>
      interpolate(secrets, value).map((resolved) => [key, resolved] as const),
    ),
  ).map((entries) => Object.fromEntries(entries));

export const httpTarget = defineTarget({
  type: 'http',
  displayName: 'HTTP request',
  description: 'Calls a REST/HTTP endpoint and verifies the response.',
  configSchema: HttpTargetConfig,
  async execute(config, { payload, ctx, signal }): Promise<TargetResult> {
    const started = performance.now();
    const elapsed = () => performance.now() - started;
    const resolved = await ResultAsync.combine([
      interpolate(ctx.secrets, config.url),
      interpolateValues(ctx.secrets, config.headers),
      interpolateValues(ctx.secrets, config.secretHeaders),
      config.signing ? interpolate(ctx.secrets, config.signing.secret) : okAsync(undefined),
    ] as const);
    if (resolved.isErr()) {
      return failedResult('missing_secret', resolved.error.message, false, elapsed());
    }
    const [rawUrl, headers, secretHeaders, signingSecret] = resolved.value;

    const url = new URL(rawUrl);
    for (const [k, v] of Object.entries(config.query)) {
      url.searchParams.set(k, v);
    }

    // GET and HEAD send no body, so headers and the signature must describe an empty one.
    const body =
      config.method === 'GET' || config.method === 'HEAD'
        ? undefined
        : (config.body ?? payload.body);
    const outgoing: Record<string, string> = {
      'user-agent': 'cloud-trigger',
      'x-cloud-trigger-run-id': ctx.runId,
      'x-cloud-trigger-attempt': String(ctx.attempt),
      ...payload.attributes,
      ...(payload.contentType && body !== undefined ? { 'content-type': payload.contentType } : {}),
      ...headers,
      ...secretHeaders,
    };
    if (config.signing && signingSecret !== undefined) {
      const timestamp = String(Math.floor(ctx.now.getTime() / 1000));
      const signature = createHmac('sha256', signingSecret)
        .update(`${timestamp}.${body ?? ''}`)
        .digest('hex');
      outgoing[config.signing.header] = `sha256=${signature}`;
      outgoing[config.signing.timestampHeader] = timestamp;
    }

    try {
      const response = await request(url, {
        method: config.method,
        headers: outgoing,
        body: body ?? null,
        signal,
        dispatcher: dispatcherFor(config.maxRedirects),
      });
      const read = await readLimited(response.body, config.maxResponseBytes);
      const durationMs = elapsed();
      const result = {
        durationMs,
        statusCode: response.statusCode,
        response: {
          headers: flattenHeaders(response.headers),
          body: read.text,
          sizeBytes: read.sizeBytes,
          truncated: read.truncated,
        },
      };
      const failure = firstFailedAssertion(config.assertions, {
        status: response.statusCode,
        body: read.text,
        durationMs,
      });
      if (failure === undefined) {
        return { outcome: 'success', ...result };
      }

      return {
        outcome: 'failure',
        ...result,
        error: {
          code: `http_assertion`,
          message: failure,
          retryable: matchesStatus(response.statusCode, config.retryOnStatus),
        },
      };
    } catch (error: unknown) {
      if (signal.aborted) {
        return abortedResult(signal, elapsed());
      }

      return failedResult(
        errorCode(error) ?? 'network_error',
        toError(error).message,
        true,
        elapsed(),
      );
    }
  },
});
