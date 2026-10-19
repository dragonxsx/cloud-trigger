import {
  Result,
  ResultAsync,
  type TargetResult,
  abortedResult,
  defineConnectedTarget,
  err,
  failedResult,
  ok,
  okAsync,
  secret,
  toError,
} from '@cloud-trigger/core';
import { parse } from 'graphql';
import { request } from 'undici';
import { z } from 'zod';

import { httpConnection, prepareRequest, urlIssues } from '../connections/http.js';
import { templateScope } from '../inputs/template.js';
import { dispatcherFor, errorCode, flattenHeaders, readLimited } from '../shared/http-client.js';
import { interpolate, interpolateValues } from '../shared/interpolate.js';
import { LiquidTemplate, renderWithSecrets } from '../shared/liquid.js';
import { SigningConfig, signatureHeaders } from '../shared/signing.js';
import {
  HttpAssertions,
  StatusPattern,
  firstFailedAssertion,
  matchesStatus,
} from './http-assertions.js';

const PARSE_LIMIT_BYTES = 4 * 1024 * 1024;
const MAX_ERRORS_KEPT = 10;

const syntaxError = (query: string): string | undefined =>
  Result.fromThrowable(
    () => parse(query),
    (error) => toError(error).message,
  )().match(
    () => undefined,
    (message) => message,
  );

export const GraphqlTargetConfig = z.object({
  url: z
    .string()
    .default('')
    .describe(
      'Absolute http(s) URL, or a path such as /graphql (empty for the base URL) when the target uses a connection. May contain {{secret:NAME}} placeholders.',
    ),
  query: z
    .string()
    .min(1)
    .superRefine((query, ctx) => {
      const message = syntaxError(query);
      if (message !== undefined) {
        ctx.addIssue({ code: 'custom', message });
      }
    })
    .describe('GraphQL document. Checked for syntax on save; the schema is not fetched.'),
  operationName: z.string().min(1).optional(),
  variables: LiquidTemplate.optional().describe(
    'Liquid template that renders to a JSON object. When empty, the input payload body is used.',
  ),
  headers: z
    .record(z.string(), z.string())
    .default({})
    .describe('Values may contain {{secret:NAME}}.'),
  secretHeaders: z
    .record(z.string(), secret(z.string()))
    .default({})
    .describe('Credential headers such as Authorization. Shown as *** and kept on edit.'),
  maxResponseBytes: z
    .int()
    .min(0)
    .max(1024 * 1024)
    .default(64 * 1024),
  retryOnStatus: z.array(StatusPattern).default(['408', '429', '5xx']),
  allowPartial: z
    .boolean()
    .default(false)
    .describe('Succeed when `errors` is non-empty but `data` is not null.'),
  retryOnErrorCodes: z
    .array(z.string().min(1))
    .default([])
    .describe('GraphQL error `extensions.code` values that make the failure retryable.'),
  assertions: HttpAssertions.prefault({}),
  signing: SigningConfig.optional(),
});
export type GraphqlTargetConfig = z.output<typeof GraphqlTargetConfig>;

const GraphqlError = z.looseObject({
  message: z.string(),
  extensions: z.looseObject({ code: z.string().optional() }).optional(),
});
const GraphqlResponse = z.looseObject({
  data: z.unknown().optional(),
  errors: z.array(GraphqlError).optional(),
});
const Variables = z.record(z.string(), z.unknown());

const parseJson = Result.fromThrowable(
  (text: string): unknown => JSON.parse(text),
  () => 'not valid JSON',
);

const toVariables = (text: string | undefined): Result<Record<string, unknown>, string> => {
  if (text === undefined || text.trim() === '') {
    return ok({});
  }

  return parseJson(text).andThen((value) => {
    const parsed = Variables.safeParse(value);

    return parsed.success ? ok(parsed.data) : err('not a JSON object');
  });
};

export const graphqlTarget = defineConnectedTarget({
  type: 'graphql',
  displayName: 'GraphQL operation',
  description: 'POSTs a GraphQL query or mutation and checks the response for errors.',
  configSchema: GraphqlTargetConfig,
  connection: httpConnection,
  check: (config, connection) => urlIssues(config.url, connection),
  async execute(config, { payload, ctx, signal, connection }): Promise<TargetResult> {
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
    const prepared = await prepareRequest(rawUrl, {}, connection, ctx.secrets, {
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

    const rendered = await ResultAsync.fromPromise(
      config.variables === undefined
        ? Promise.resolve(payload.body)
        : renderWithSecrets(config.variables, templateScope(ctx), ctx.secrets),
      toError,
    );
    if (rendered.isErr()) {
      return failedResult('invalid_variables', rendered.error.message, false, elapsed());
    }
    const variables = toVariables(rendered.value);
    if (variables.isErr()) {
      return failedResult(
        'invalid_variables',
        `Variables are ${variables.error}`,
        false,
        elapsed(),
      );
    }

    const body = JSON.stringify({
      query: config.query,
      ...(config.operationName !== undefined && { operationName: config.operationName }),
      variables: variables.value,
    });
    const outgoing: Record<string, string> = {
      'user-agent': 'cloud-trigger',
      accept: 'application/graphql-response+json, application/json',
      'x-cloud-trigger-run-id': ctx.runId,
      'x-cloud-trigger-attempt': String(ctx.attempt),
      ...(ctx.traceparent !== undefined && { traceparent: ctx.traceparent }),
      ...prepared.value.connection?.headers,
      ...headers,
      ...secretHeaders,
      'content-type': 'application/json',
    };
    if (signing) {
      Object.assign(
        outgoing,
        signatureHeaders(signing.config, { secret: signing.secret, body, now: ctx.now }),
      );
    }

    try {
      const response = await request(url, {
        method: 'POST',
        headers: outgoing,
        body,
        signal,
        dispatcher: dispatcherFor(0),
      });
      const read = await readLimited(
        response.body,
        Math.max(config.maxResponseBytes, PARSE_LIMIT_BYTES),
      );
      const durationMs = elapsed();
      const kept = Buffer.from(read.text, 'utf8');
      const base = {
        durationMs,
        statusCode: response.statusCode,
        response: {
          headers: flattenHeaders(response.headers),
          body: kept.subarray(0, config.maxResponseBytes).toString('utf8'),
          sizeBytes: read.sizeBytes,
          truncated: read.sizeBytes > config.maxResponseBytes,
        },
      };
      const failure = (code: string, message: string, retryable: boolean, extra = {}) => ({
        outcome: 'failure' as const,
        ...base,
        metadata: { sizeBytes: read.sizeBytes, ...extra },
        error: { code, message, retryable },
      });

      if (!matchesStatus(response.statusCode, config.assertions.expectedStatus)) {
        return failure(
          'http_status',
          `Status ${response.statusCode} not in [${config.assertions.expectedStatus.join(', ')}]`,
          matchesStatus(response.statusCode, config.retryOnStatus),
        );
      }
      const json = parseJson(read.text);
      const parsed = json.isOk() ? GraphqlResponse.safeParse(json.value) : undefined;
      if (parsed === undefined || !parsed.success) {
        return failure('invalid_response', 'Response is not a GraphQL JSON response', false);
      }
      const errors = parsed.data.errors ?? [];
      const metadata = {
        sizeBytes: read.sizeBytes,
        ...(errors.length > 0 && { errors: errors.slice(0, MAX_ERRORS_KEPT) }),
      };
      const hasData = parsed.data.data !== undefined && parsed.data.data !== null;
      if (errors.length > 0 && !(config.allowPartial && hasData)) {
        const retryable = errors.some(
          (error) =>
            error.extensions?.code !== undefined &&
            config.retryOnErrorCodes.includes(error.extensions.code),
        );

        return failure(
          'graphql_error',
          errors.map((error) => error.message).join('; '),
          retryable,
          metadata,
        );
      }
      const assertion = firstFailedAssertion(config.assertions, {
        status: response.statusCode,
        body: read.text,
        durationMs,
      });
      if (assertion !== undefined) {
        return failure('http_assertion', assertion, false, metadata);
      }

      return { outcome: 'success', ...base, metadata };
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
