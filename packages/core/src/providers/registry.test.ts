import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { REDACTED, redactBySchema, restoreRedacted } from './redact.js';
import { ProviderRegistry } from './registry.js';
import { defineTarget, secret } from './sdk.js';

const echo = defineTarget({
  type: 'echo',
  displayName: 'Echo',
  configSchema: z.object({ url: z.url(), token: secret(z.string()).optional() }),
  execute: async (config) => ({ outcome: 'success', durationMs: 0, metadata: { url: config.url } }),
});

describe('ProviderRegistry', () => {
  it('binds a provider with parsed config', async () => {
    const registry = new ProviderRegistry().register(echo);
    const bound = registry
      .get('target', 'echo')
      .andThen((p) => p.bind({ url: 'https://example.com' }))
      ._unsafeUnwrap();
    const result = await bound.execute({
      payload: { body: undefined, contentType: undefined, attributes: {} },
      signal: AbortSignal.timeout(1_000),
      ctx: {
        runId: 'r',
        jobId: 'j',
        jobName: 'n',
        attempt: 1,
        scheduledAt: new Date(),
        reason: 'manual',
        now: new Date(),
        secrets: {
          get: async () => undefined,
          interpolate: async (s) => (await import('neverthrow')).ok(s),
        },
      },
    });
    expect(result.metadata).toEqual({ url: 'https://example.com' });
  });

  it('returns config errors and unknown provider errors as values', () => {
    const registry = new ProviderRegistry().register(echo);
    const invalid = registry.get('target', 'echo').andThen((p) => p.bind({ url: 'nope' }));
    expect(invalid._unsafeUnwrapErr().code).toBe('invalid_config');
    expect(registry.get('target', 'missing')._unsafeUnwrapErr().code).toBe('unknown_provider');
  });

  it('rejects duplicates', () => {
    expect(() => new ProviderRegistry().register(echo, echo)).toThrow(/Duplicate/);
  });

  it('redacts secret fields using the exported JSON schema', () => {
    const schema = new ProviderRegistry().register(echo).list('target')[0]?.configSchema;
    expect(redactBySchema(schema, { url: 'https://x.y', token: 'abc' })).toEqual({
      url: 'https://x.y',
      token: REDACTED,
    });
    expect(redactBySchema(schema, { token: null })).toEqual({ token: null });
  });

  it('redacts and restores secret record values', () => {
    const schema = z.toJSONSchema(
      z.object({
        plain: z.record(z.string(), z.string()),
        hidden: z.record(z.string(), secret(z.string())),
      }),
    );
    const stored = { plain: { accept: 'json' }, hidden: { authorization: 'Bearer abc' } };
    const redacted = redactBySchema(schema, stored);
    expect(redacted).toEqual({ plain: { accept: 'json' }, hidden: { authorization: REDACTED } });
    expect(restoreRedacted(schema, redacted, stored)).toEqual(stored);
  });

  it('restores redacted secrets on update', () => {
    const schema = new ProviderRegistry().register(echo).list('target')[0]?.configSchema;
    expect(
      restoreRedacted(
        schema,
        { url: 'https://n.ew', token: REDACTED },
        { url: 'https://o.ld', token: 'abc' },
      ),
    ).toEqual({
      url: 'https://n.ew',
      token: 'abc',
    });
  });

  it('applies only the union branch whose discriminator matches', () => {
    const schema = z.toJSONSchema(
      z.object({
        targets: z.array(
          z.discriminatedUnion('type', [
            z.object({ type: z.literal('a'), config: z.object({ key: secret(z.string()) }) }),
            z.object({ type: z.literal('b'), config: z.object({ key: z.string() }) }),
          ]),
        ),
      }),
    );
    const stored = {
      targets: [
        { type: 'a', config: { key: 'hidden' } },
        { type: 'b', config: { key: 'visible' } },
      ],
    };
    const redacted = redactBySchema(schema, stored);
    expect(redacted).toEqual({
      targets: [
        { type: 'a', config: { key: REDACTED } },
        { type: 'b', config: { key: 'visible' } },
      ],
    });
    expect(restoreRedacted(schema, redacted, stored)).toEqual(stored);
  });
});
