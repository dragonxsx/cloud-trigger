import {
  type Payload,
  REDACTED,
  type RunContext,
  type TargetProvider,
  type TargetResult,
  isRecord,
  mapSecretResolver,
  redactBySchema,
} from '@cloud-trigger/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

export interface TargetContractHarness {
  readonly setup?: () => Promise<void>;
  readonly teardown?: () => Promise<void>;
  readonly succeeding: () => unknown;
  readonly slow: () => unknown;
  readonly retryableFailure: () => unknown;
  readonly terminalFailure: () => unknown;
  readonly invalid: unknown;
  readonly secretPaths: readonly (readonly string[])[];
  readonly withSecrets?: () => unknown;
  readonly secrets?: Readonly<Record<string, string>>;
  readonly payload?: Payload;
  readonly lastTraceparent?: () => Promise<string | undefined>;
  readonly timeoutMs?: number;
}

export const CONTRACT_TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

export const contractRunContext = (secrets: Readonly<Record<string, string>> = {}): RunContext => ({
  runId: '0190a000-0000-7000-8000-000000000001',
  jobId: '0190a000-0000-7000-8000-000000000002',
  jobName: 'Contract job',
  attempt: 1,
  scheduledAt: new Date('2026-01-01T00:00:00Z'),
  reason: 'manual',
  secrets: mapSecretResolver(secrets),
  now: new Date('2026-01-01T00:00:01Z'),
  traceparent: CONTRACT_TRACEPARENT,
});

const valueAt = (value: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>((current, key) => {
    if (Array.isArray(current)) {
      const item: unknown = current[Number(key)];

      return item;
    }

    return isRecord(current) ? current[key] : undefined;
  }, value);

export function describeTargetContract(provider: TargetProvider, harness: TargetContractHarness) {
  const payload: Payload = harness.payload ?? {
    body: '{"contract":true}',
    contentType: 'application/json',
    attributes: {},
  };
  const timeoutMs = harness.timeoutMs ?? 10_000;

  const execute = (config: unknown, signal: AbortSignal): Promise<TargetResult> => {
    const bound = provider.bind(config);
    if (bound.isErr()) {
      throw new Error(`Harness config does not bind: ${bound.error.message}`);
    }

    return bound.value.execute({ payload, ctx: contractRunContext(harness.secrets), signal });
  };

  describe(`${provider.type}: target contract`, { timeout: timeoutMs + 5_000 }, () => {
    beforeAll(async () => {
      await harness.setup?.();
    }, 180_000);
    afterAll(async () => {
      await harness.teardown?.();
    }, 60_000);

    it('succeeds against a healthy endpoint', async () => {
      const result = await execute(harness.succeeding(), AbortSignal.timeout(timeoutMs));
      expect(result.error).toBeUndefined();
      expect(result.outcome).toBe('success');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('propagates the run traceparent', async ({ skip }) => {
      if (!harness.lastTraceparent) {
        skip();

        return;
      }
      await execute(harness.succeeding(), AbortSignal.timeout(timeoutMs));
      expect(await harness.lastTraceparent()).toBe(CONTRACT_TRACEPARENT);
    });

    it('marks transient failures retryable', async () => {
      const result = await execute(harness.retryableFailure(), AbortSignal.timeout(timeoutMs));
      expect(result.outcome).toBe('failure');
      expect(result.error?.retryable).toBe(true);
    });

    it('marks permanent failures not retryable', async () => {
      const result = await execute(harness.terminalFailure(), AbortSignal.timeout(timeoutMs));
      expect(result.outcome).toBe('failure');
      expect(result.error?.retryable).toBe(false);
    });

    it('reports a timeout as a retryable timeout', async () => {
      const result = await execute(harness.slow(), AbortSignal.timeout(150));
      expect(result.outcome).toBe('failure');
      expect(result.error).toMatchObject({ code: 'timeout', retryable: true });
    });

    it('reports cancellation as a non-retryable cancel', async () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error('Cancelled by test')), 150);
      const result = await execute(harness.slow(), controller.signal);
      expect(result.outcome).toBe('failure');
      expect(result.error).toMatchObject({ code: 'cancelled', retryable: false });
    });

    it('redacts every secret field', () => {
      const config = harness.withSecrets?.() ?? harness.succeeding();
      expect(provider.bind(config).isOk()).toBe(true);
      const redacted = redactBySchema(provider.jsonSchema(), config);
      for (const path of harness.secretPaths) {
        expect({ path: path.join('.'), value: valueAt(redacted, path) }).toEqual({
          path: path.join('.'),
          value: REDACTED,
        });
      }
    });

    it('rejects an invalid config with field issues', () => {
      const bound = provider.bind(harness.invalid);
      expect(bound.isErr()).toBe(true);
      expect(bound.isErr() && bound.error.issues.length).toBeGreaterThan(0);
    });
  });
}
