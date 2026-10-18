import { isDeepStrictEqual } from 'node:util';

import { Result } from '@cloud-trigger/core';
import { JSONPath } from 'jsonpath-plus';
import { z } from 'zod';

export const StatusPattern = z
  .string()
  .regex(/^(?:[1-5]xx|\d{3}(?:-\d{3})?)$/, 'Use 2xx, 404 or 200-299');

export const JsonPathAssertion = z
  .object({ path: z.string().min(1), equals: z.json().optional() })
  .describe('Passes when the path matches; if `equals` is set the first match must deep-equal it.');
export type JsonPathAssertion = z.output<typeof JsonPathAssertion>;

export function jsonPathFailure(check: JsonPathAssertion, json: unknown): string | undefined {
  if (json === null || typeof json !== 'object') {
    return 'JSON body is not an object or array';
  }
  const matches: unknown = JSONPath({ path: check.path, json, wrap: true });
  if (!Array.isArray(matches) || matches.length === 0) {
    return `JSONPath ${check.path} matched nothing`;
  }
  const first: unknown = matches[0];
  if (check.equals !== undefined && !isDeepStrictEqual(first, check.equals)) {
    return `JSONPath ${check.path} = ${JSON.stringify(first)}, expected ${JSON.stringify(check.equals)}`;
  }

  return undefined;
}

export const HttpAssertions = z.object({
  expectedStatus: z.array(StatusPattern).min(1).default(['2xx']),
  bodyContains: z.string().optional(),
  jsonPath: JsonPathAssertion.optional(),
  maxLatencyMs: z.int().positive().optional(),
});
export type HttpAssertions = z.output<typeof HttpAssertions>;

export const matchesStatus = (status: number, patterns: readonly string[]): boolean =>
  patterns.some((pattern) => {
    if (pattern.endsWith('xx')) {
      return Math.floor(status / 100) === Number(pattern[0]);
    }
    const [lo, hi] = pattern.split('-').map(Number);

    return hi === undefined ? status === lo : lo !== undefined && status >= lo && status <= hi;
  });

const parseJson = Result.fromThrowable((text: string): unknown => JSON.parse(text));

export function firstFailedAssertion(
  assertions: HttpAssertions,
  response: { status: number; body: string; durationMs: number },
): string | undefined {
  if (!matchesStatus(response.status, assertions.expectedStatus)) {
    return `Status ${response.status} not in [${assertions.expectedStatus.join(', ')}]`;
  }
  if (assertions.maxLatencyMs !== undefined && response.durationMs > assertions.maxLatencyMs) {
    return `Latency ${Math.round(response.durationMs)}ms exceeded ${assertions.maxLatencyMs}ms`;
  }
  if (assertions.bodyContains !== undefined && !response.body.includes(assertions.bodyContains)) {
    return `Body does not contain "${assertions.bodyContains}"`;
  }
  if (assertions.jsonPath) {
    const parsed = parseJson(response.body);
    if (parsed.isErr()) {
      return 'Body is not valid JSON';
    }

    return jsonPathFailure(assertions.jsonPath, parsed.value);
  }

  return undefined;
}
