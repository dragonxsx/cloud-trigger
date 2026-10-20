import { type JobId, createConnection, newConnectionId } from '@cloud-trigger/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { useHarness } from './harness.js';

const h = useHarness('notifications');

const HookBody = z.object({ event: z.string(), idempotencyKey: z.string() });
const hookEvents = () =>
  h.requests
    .filter((r) => r.path.startsWith('/hook'))
    .map((r) => HookBody.parse(JSON.parse(r.body)));

const webhookRule = (on: readonly string[]) => ({
  on,
  notifier: { type: 'webhook', config: { url: `${h.base()}/hook` } },
});

const fireOnce = async (jobId: JobId) => {
  const job = await h.db.jobs.get(jobId);
  if (!job?.schedule.nextFireAt) {
    throw new Error('job not scheduled');
  }
  h.setNow(job.schedule.nextFireAt);
  await h.scheduler().tick();
};

describe('notifications', () => {
  it('resolves the notifier connection when sending, so a rotated base URL reaches retries', async () => {
    h.route('/old', () => ({ status: 500 }));
    const saved = createConnection({
      id: newConnectionId(),
      spec: {
        key: 'hooks',
        name: '',
        description: '',
        type: 'http',
        config: { baseUrl: `${h.base()}/old` },
        endpoints: [
          {
            key: 'alerts',
            name: '',
            description: '',
            notifier: { type: 'webhook', config: { url: '/hook' } },
          },
        ],
        overlays: [],
      },
      now: h.clock.now(),
    });
    (await h.db.connections.insert(saved))._unsafeUnwrap();
    const job = await h.createJob('/ok', {
      notifications: [
        {
          on: ['success'],
          notifier: {
            type: 'webhook',
            config: {},
            connection: { key: 'hooks', endpoint: 'alerts' },
          },
        },
      ],
    });
    await fireOnce(job.id);
    await h.settle(h.worker());

    const dispatcher = h.dispatcher();
    expect(await dispatcher.tick()).toBe(true);
    (
      await h.db.connections.update(
        'hooks',
        { spec: { ...saved, config: { baseUrl: h.base() } }, updatedAt: h.clock.now() },
        saved.version,
      )
    )._unsafeUnwrap();
    h.advance(1_000);
    expect(await dispatcher.tick()).toBe(true);

    expect(h.requests.filter((r) => r.path === '/old/hook')).toHaveLength(1);
    expect(hookEvents()).toHaveLength(1);
    const [run] = (await h.db.runs.list({ limit: 10, jobId: job.id })).items;
    const deliveries = run ? await h.db.outbox.listByRun(run.id) : [];
    expect(deliveries[0]).toMatchObject({
      status: 'delivered',
      notifier: { connection: { key: 'hooks', endpoint: 'alerts' } },
    });
  });

  it('delivers through the outbox and retries after a 500', async () => {
    let calls = 0;
    h.route('/hook', () => ({ status: ++calls === 1 ? 500 : 200 }));
    const job = await h.createJob('/ok', { notifications: [webhookRule(['success'])] });
    await fireOnce(job.id);
    await h.settle(h.worker());

    const dispatcher = h.dispatcher();
    expect(await dispatcher.tick()).toBe(true);
    expect(await dispatcher.tick()).toBe(false);
    h.advance(1_000);
    expect(await dispatcher.tick()).toBe(true);

    const [run] = (await h.db.runs.list({ limit: 10, jobId: job.id })).items;
    if (!run) {
      throw new Error('expected a run');
    }
    const deliveries = await h.db.outbox.listByRun(run.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      status: 'delivered',
      attempts: 2,
      lastError: 'Webhook responded 500',
    });
    const keys = hookEvents().map((e) => e.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
  });

  it('sends two failure and one permanent_failure for maxAttempts 3', async () => {
    const job = await h.createJob('/fail', {
      notifications: [webhookRule(['failure', 'permanent_failure'])],
      policy: { retry: { maxAttempts: 3, backoff: 'fixed', delayMs: 1_000 } },
    });
    await fireOnce(job.id);
    for (let attempt = 0; attempt < 3; attempt++) {
      await h.settle(h.worker());
      h.advance(1_000);
    }
    expect((await h.db.runs.list({ limit: 10, jobId: job.id })).items[0]?.status).toBe('failed');

    await h.drainOutbox();
    const events = hookEvents().map((e) => e.event);
    expect(events.filter((e) => e === 'failure')).toHaveLength(2);
    expect(events.filter((e) => e === 'permanent_failure')).toHaveLength(1);
  });

  it('redelivers exactly once after a dispatcher dies mid-dispatch', async () => {
    const job = await h.createJob('/ok', { notifications: [webhookRule(['success'])] });
    await fireOnce(job.id);
    await h.settle(h.worker());

    const orphaned = await h.db.outbox.claimNext({
      workerId: 'crashed',
      now: h.now(),
      leaseMs: 10_000,
    });
    if (!orphaned) {
      throw new Error('expected a claim');
    }
    expect(await h.dispatcher({ workerId: 'd2' }).tick()).toBe(false);
    h.advance(10_001);
    await h.drainOutbox();
    h.advance(60_000);
    await h.drainOutbox();

    expect(hookEvents()).toHaveLength(1);
    expect(await h.db.outbox.complete(orphaned, h.now())).toBe(false);
    const [run] = (await h.db.runs.list({ limit: 1, jobId: job.id })).items;
    if (!run) {
      throw new Error('expected a run');
    }
    expect((await h.db.outbox.listByRun(run.id)).map((d) => d.status)).toEqual(['delivered']);
  });
});
