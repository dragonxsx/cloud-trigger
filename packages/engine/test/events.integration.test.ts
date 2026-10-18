import { setTimeout as sleep } from 'node:timers/promises';

import {
  type SourceMessage,
  defineEventSource,
  mapSecretResolver,
  silentLogger,
} from '@cloud-trigger/core';
import { signatureHeaders } from '@cloud-trigger/providers-builtin';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ConsumerSupervisor, EventIngestor } from '../src/index.js';
import { useHarness } from './harness.js';

const h = useHarness('events');

interface Channel {
  readonly queue: SourceMessage[];
  readonly acked: string[];
  active: number;
  maxActive: number;
}
const channels = new Map<string, Channel>();
const channel = (name: string): Channel => {
  const existing = channels.get(name);
  if (existing) {
    return existing;
  }
  const created: Channel = { queue: [], acked: [], active: 0, maxActive: 0 };
  channels.set(name, created);

  return created;
};

const memorySource = (type: string, exclusive: boolean) =>
  defineEventSource({
    type,
    displayName: 'Memory queue',
    exclusive,
    configSchema: z.object({ channel: z.string() }),
    describe: (config) => `memory ${config.channel}`,
    async subscribe(config, ctx) {
      const state = channel(config.channel);
      state.active++;
      state.maxActive = Math.max(state.maxActive, state.active);
      try {
        while (!ctx.signal.aborted) {
          const next = state.queue[0];
          if (next) {
            await ctx.emit(next);
            state.queue.shift();
            state.acked.push(next.id);
          } else {
            await sleep(10, undefined, { signal: ctx.signal }).catch(() => undefined);
          }
        }
      } finally {
        state.active--;
      }
    },
  });
h.registry.register(memorySource('memq', true), memorySource('memq_shared', false));

const ingestor = (perSecond?: number) =>
  new EventIngestor({
    ...h.db,
    registry: h.registry,
    secrets: mapSecretResolver({ HOOK_TOKEN: 'hook-token-from-store' }),
    clock: h.clock,
    logger: silentLogger,
    ...(perSecond !== undefined && { defaultWebhookPerSecond: perSecond }),
  });

const supervisor = (ownerId: string) =>
  new ConsumerSupervisor(
    {
      ...h.db,
      registry: h.registry,
      secrets: mapSecretResolver({}),
      clock: h.clock,
      logger: silentLogger,
      ingestor: ingestor(),
    },
    { ownerId, intervalMs: 50, leaseMs: 1_000, restartDelayMs: 20 },
  );

const waitFor = async (check: () => Promise<boolean> | boolean, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await sleep(20);
  }
};

const webhookJob = (config: Record<string, unknown>) =>
  h.createJob('/hook-target', {
    trigger: { type: 'webhook', config: { token: 'a-long-enough-token', ...config } },
    input: {
      type: 'template',
      config: { template: '{"order":{{ event.body.id }},"via":"{{ event.source }}"}' },
    },
    target: { type: 'http', config: { method: 'POST', url: `${h.base()}/hook-target` } },
  });

describe('inbound webhooks', () => {
  it('queues an event run that renders the request into the payload', async () => {
    const job = await webhookJob({});
    expect(job.schedule.nextFireAt).toBeNull();
    expect(job.eventSource).toBeNull();

    const received = await ingestor().receiveWebhook(job.id, {
      token: 'a-long-enough-token',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'evt-1' },
      body: '{"id":7}',
    });
    expect(received._unsafeUnwrap()).toMatchObject({ duplicate: false });
    const [run] = (await h.db.runs.list({ limit: 5, jobId: job.id })).items;
    expect(run).toMatchObject({
      reason: 'event',
      idempotencyKey: `event:${job.id}:evt-1`,
      event: { kind: 'webhook', source: 'webhook', id: 'evt-1', body: '{"id":7}' },
    });

    await h.settle(h.worker());
    expect(h.requests.find((r) => r.path === '/hook-target')?.body).toBe(
      '{"order":7,"via":"webhook"}',
    );
  });

  it('runs a redelivered event once, even after its run is pruned', async () => {
    const job = await webhookJob({});
    const deliver = () =>
      ingestor().receiveWebhook(job.id, {
        token: 'a-long-enough-token',
        headers: { 'idempotency-key': 'evt-dup' },
        body: '{"id":1}',
      });
    expect((await deliver())._unsafeUnwrap().duplicate).toBe(false);
    await h.clear(['runs']);
    expect((await deliver())._unsafeUnwrap()).toEqual({ runId: null, duplicate: true });
  });

  it('hides jobs behind a wrong token and rejects bad signatures', async () => {
    const job = await webhookJob({ token: '{{secret:HOOK_TOKEN}}', signing: { secret: 'k' } });
    const wrongToken = await ingestor().receiveWebhook(job.id, {
      token: 'nope-nope-nope-nope',
      headers: {},
      body: '{}',
    });
    expect(wrongToken._unsafeUnwrapErr().code).toBe('not_found');

    const unsigned = await ingestor().receiveWebhook(job.id, {
      token: 'hook-token-from-store',
      headers: {},
      body: '{"id":1}',
    });
    expect(unsigned._unsafeUnwrapErr().code).toBe('unauthorized');

    const signed = signatureHeaders(
      { header: 'x-signature', timestampHeader: 'x-signature-timestamp' },
      { secret: 'k', body: '{"id":1}', now: h.now() },
    );
    const accepted = await ingestor().receiveWebhook(job.id, {
      token: 'hook-token-from-store',
      headers: signed,
      body: '{"id":1}',
    });
    expect(accepted.isOk()).toBe(true);
  });

  it('rate-limits deliveries per job and refuses paused jobs', async () => {
    const job = await webhookJob({ rateLimit: { perSecond: 1 } });
    const deliver = (id: string) =>
      ingestor().receiveWebhook(job.id, {
        token: 'a-long-enough-token',
        headers: { 'idempotency-key': id },
        body: '{"id":1}',
      });
    expect((await deliver('a')).isOk()).toBe(true);
    const limited = await deliver('b');
    expect(limited._unsafeUnwrapErr()).toMatchObject({
      code: 'rate_limited',
      retryAfterSeconds: 1,
    });
    h.advance(1_000);
    expect((await deliver('c')).isOk()).toBe(true);

    await h.service().pause(job.id, 'maintenance');
    h.advance(1_000);
    expect((await deliver('d'))._unsafeUnwrapErr().code).toBe('job_paused');
  });

  it('does not accept webhooks for jobs with other triggers', async () => {
    const job = await h.createJob('/scheduled');
    const result = await ingestor().receiveWebhook(job.id, {
      token: 'a-long-enough-token',
      headers: {},
      body: '',
    });
    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });
});

const sourceJob = (type: string, name: string) =>
  h.createJob(`/consumed-${name}`, {
    trigger: { type, config: { channel: name } },
    input: { type: 'event', config: {} },
    target: { type: 'http', config: { method: 'POST', url: `${h.base()}/consumed-${name}` } },
  });

describe('queue consumers', () => {
  it('lets exactly one replica consume an exclusive source and fails over', async () => {
    const job = await sourceJob('memq', 'orders');
    expect(job.eventSource).toBe('memq');
    const [a, b] = [supervisor('a'), supervisor('b')];
    await a.tick();
    await b.tick();
    expect(a.activeSubscriptions).toEqual([job.id]);
    expect(b.activeSubscriptions).toEqual([]);

    channel('orders').queue.push(
      { id: 'm1', body: '{"n":1}', headers: { 'content-type': 'application/json' } },
      { id: 'm2', body: '{"n":2}', headers: {} },
    );
    await waitFor(() => channel('orders').acked.length === 2);
    const runs = (await h.db.runs.list({ limit: 10, jobId: job.id })).items;
    expect(
      runs.map((r) => r.idempotencyKey ?? '').toSorted((left, right) => left.localeCompare(right)),
    ).toEqual([`event:${job.id}:m1`, `event:${job.id}:m2`]);
    expect(runs.every((r) => r.reason === 'event' && r.event?.kind === 'message')).toBe(true);

    await a.stop();
    await b.tick();
    expect(b.activeSubscriptions).toEqual([job.id]);
    expect(channel('orders').maxActive).toBe(1);
    await b.stop();

    const worker = h.worker();
    await waitFor(async () => {
      await worker.tick();
      h.advance(2_000);

      return h.requests.filter((r) => r.path === '/consumed-orders').length === 2;
    });
    await worker.stop();
    expect(
      h.requests
        .filter((r) => r.path === '/consumed-orders')
        .map((r) => r.body)
        .toSorted(),
    ).toEqual(['{"n":1}', '{"n":2}']);
  });

  it('runs non-exclusive sources on every replica and stops when the job is paused', async () => {
    const job = await sourceJob('memq_shared', 'shared');
    const [a, b] = [supervisor('a'), supervisor('b')];
    await a.tick();
    await b.tick();
    expect(channel('shared').active).toBe(2);

    await h.service().pause(job.id, 'stop');
    await a.tick();
    await b.tick();
    expect(a.activeSubscriptions).toEqual([]);
    await waitFor(() => channel('shared').active === 0);
    await a.stop();
    await b.stop();
  });

  it('keeps unacknowledged messages when the run cannot be queued', async () => {
    const job = await sourceJob('memq', 'paused');
    const consumer = supervisor('a');
    await consumer.tick();
    await h.db.jobs.patchSchedule(job.id, {}, { pausedReason: 'held' });
    channel('paused').queue.push({ id: 'p1', body: 'x', headers: {} });
    await sleep(100);
    expect(channel('paused').acked).toEqual([]);
    expect(channel('paused').queue).toHaveLength(1);
    await consumer.stop();
  });
});
