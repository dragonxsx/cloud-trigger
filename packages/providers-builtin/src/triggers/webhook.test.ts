import { mapSecretResolver } from '@cloud-trigger/core';
import { describe, expect, it } from 'vitest';

import { eventInput } from '../inputs/event.js';
import { templateInput } from '../inputs/template.js';
import { signatureHeaders } from '../shared/signing.js';
import { testContext } from '../test-helpers.js';
import { webhookTrigger } from './webhook.js';

const NOW = new Date('2026-01-01T00:00:00Z');
const ctx = { secrets: mapSecretResolver({ HOOK: 'from-secret-store-123' }), now: NOW };

const bind = (config: Record<string, unknown>) => {
  const bound = webhookTrigger.bind(config);
  if (bound.isErr() || !bound.value.inbound) {
    throw new Error('webhook trigger did not bind');
  }

  return bound.value;
};

const request = (token: string, headers: Record<string, string> = {}, body = '{"a":1}') => ({
  token,
  headers,
  body,
  receivedAt: NOW,
});

describe('webhook trigger', () => {
  it('accepts the configured token, resolving secret placeholders', async () => {
    const trigger = bind({ token: '{{secret:HOOK}}' });
    expect(await trigger.inbound?.(request('from-secret-store-123'), ctx)).toMatchObject({
      accepted: true,
    });
    expect(await trigger.inbound?.(request('wrong-token-000000'), ctx)).toEqual({
      accepted: false,
      reason: 'unauthorized',
    });
  });

  it('rejects tokens shorter than 16 characters on save', () => {
    expect(webhookTrigger.bind({ token: 'short' }).isErr()).toBe(true);
  });

  it('uses the idempotency header as the delivery id, else a body hash', async () => {
    const trigger = bind({ token: 'a-very-long-token-1' });
    const keyed = await trigger.inbound?.(
      request('a-very-long-token-1', { 'idempotency-key': 'evt_1' }),
      ctx,
    );
    expect(keyed).toMatchObject({ accepted: true, deliveryId: 'evt_1' });
    const hashed = await trigger.inbound?.(request('a-very-long-token-1'), ctx);
    const again = await trigger.inbound?.(request('a-very-long-token-1'), ctx);
    expect(hashed?.accepted && hashed.deliveryId).toMatch(/^[0-9a-f]{64}$/);
    expect(again).toEqual(hashed);
  });

  it('verifies HMAC signatures within the tolerance window', async () => {
    const trigger = bind({
      token: 'a-very-long-token-1',
      signing: { secret: 'k' },
      rateLimit: { perSecond: 5 },
    });
    const signed = signatureHeaders(
      { header: 'x-signature', timestampHeader: 'x-signature-timestamp' },
      { secret: 'k', body: '{"a":1}', now: NOW },
    );
    expect(await trigger.inbound?.(request('a-very-long-token-1', signed), ctx)).toMatchObject({
      accepted: true,
      perSecond: 5,
    });
    expect(await trigger.inbound?.(request('a-very-long-token-1', signed, '{"a":2}'), ctx)).toEqual(
      { accepted: false, reason: 'invalid_signature' },
    );
    const stale = { ...ctx, now: new Date(NOW.getTime() + 301_000) };
    expect(await trigger.inbound?.(request('a-very-long-token-1', signed), stale)).toEqual({
      accepted: false,
      reason: 'invalid_signature',
    });
  });

  it('matches only webhook events', () => {
    const trigger = bind({ token: 'a-very-long-token-1' });
    expect(
      trigger.matches?.({ kind: 'run_finished', jobId: 'j', runId: 'r', status: 'succeeded' }),
    ).toBe(false);
  });
});

describe('event payloads', () => {
  const event = {
    kind: 'webhook' as const,
    source: 'webhook',
    id: 'evt_1',
    body: '{"order":{"id":42}}',
    headers: { 'content-type': 'application/json', 'x-github-event': 'push' },
    receivedAt: NOW,
  };

  it('forwards the event body, content type and chosen headers', async () => {
    const input = eventInput.bind({ forwardHeaders: ['X-GitHub-Event'] })._unsafeUnwrap();
    expect(await input.resolve(testContext({ trigger: { event } }))).toEqual({
      body: event.body,
      contentType: 'application/json',
      attributes: { 'X-GitHub-Event': 'push' },
    });
    expect((await input.resolve(testContext())).body).toBeUndefined();
  });

  it('exposes the parsed event body to templates', async () => {
    const input = templateInput
      .bind({
        template: '{"id":{{ event.body.order.id }},"via":"{{ event.headers["x-github-event"] }}"}',
      })
      ._unsafeUnwrap();
    expect((await input.resolve(testContext({ trigger: { event } }))).body).toBe(
      '{"id":42,"via":"push"}',
    );
  });
});
