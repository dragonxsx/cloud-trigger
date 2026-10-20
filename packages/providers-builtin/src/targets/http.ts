import {
  ResultAsync,
  type TargetResult,
  abortedResult,
  defineConnectedTarget,
  failedResult,
  okAsync,
  secret,
  toError,
} from '@cloud-trigger/core';
import { request } from 'undici';
import { z } from 'zod';

import { httpConnection, prepareRequest, urlIssues } from '../connections/http.js';
import { dispatcherFor, errorCode, flattenHeaders, readLimited } from '../shared/http-client.js';
import { interpolate, interpolateValues } from '../shared/interpolate.js';
import { fillPathParams } from '../shared/path-params.js';
import { SigningConfig, signatureHeaders } from '../shared/signing.js';
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
    .describe(
      'Absolute http(s) URL, or a path such as /v1/charges/{id}?x=1 when the target uses a connection. May contain {name} path parameters and {{secret:NAME}} placeholders.',
    ),
  pathParams: z
    .record(z.string(), z.string())
    .default({})
    .describe(
      'Values for the {name} path parameters in url, URL-encoded. Values may contain {{secret:NAME}}.',
    ),
  headers: z
    .record(z.string(), z.string())
    .default({})
    .describe('Values may contain {{secret:NAME}}. Override connection headers of the same name.'),
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
  signing: SigningConfig.optional(),
});
export type HttpTargetConfig = z.output<typeof HttpTargetConfig>;

export const httpTarget = defineConnectedTarget({
  type: 'http',
  displayName: 'HTTP request',
  description: 'Calls a REST/HTTP endpoint and verifies the response.',
  configSchema: HttpTargetConfig,
  connection: httpConnection,
  check: (config, connection) => urlIssues(config.url, connection),
  async execute(config, { payload, ctx, signal, connection }): Promise<TargetResult> {
    const started = performance.now();
    const elapsed = () => performance.now() - started;
    const resolved = await ResultAsync.combine([
      interpolate(ctx.secrets, config.url),
      interpolateValues(ctx.secrets, config.pathParams),
      interpolateValues(ctx.secrets, config.headers),
      interpolateValues(ctx.secrets, config.secretHeaders),
      config.signing ? interpolate(ctx.secrets, config.signing.secret) : okAsync(undefined),
    ] as const);
    if (resolved.isErr()) {
      return failedResult('missing_secret', resolved.error.message, false, elapsed());
    }
    const [templateUrl, pathParams, headers, secretHeaders, signingSecret] = resolved.value;
    const filled = fillPathParams(templateUrl, pathParams);
    if (filled.isErr()) {
      const { code, message, retryable } = filled.error;

      return failedResult(code, message, retryable, elapsed());
    }
    const prepared = await prepareRequest(filled.value, config.query, connection, ctx.secrets, {
      now: ctx.now,
      signal,
    });
    if (prepared.isErr()) {
      const { code, message, retryable } = prepared.error;

      return failedResult(code, message, retryable, elapsed());
    }
    const { url } = prepared.value;
    const signing = config.signing
      ? signingSecret === undefined
        ? undefined
        : { config: config.signing, secret: signingSecret }
      : prepared.value.connection?.signing;

    // GET and HEAD send no body, so headers and the signature must describe an empty one.
    const body =
      config.method === 'GET' || config.method === 'HEAD'
        ? undefined
        : (config.body ?? payload.body);
    const outgoing: Record<string, string> = {
      'user-agent': 'cloud-trigger',
      'x-cloud-trigger-run-id': ctx.runId,
      'x-cloud-trigger-attempt': String(ctx.attempt),
      ...(ctx.traceparent !== undefined && { traceparent: ctx.traceparent }),
      ...payload.attributes,
      ...(payload.contentType && body !== undefined ? { 'content-type': payload.contentType } : {}),
      ...prepared.value.connection?.headers,
      ...headers,
      ...secretHeaders,
    };
    if (signing) {
      Object.assign(
        outgoing,
        signatureHeaders(signing.config, { secret: signing.secret, body, now: ctx.now }),
      );
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
