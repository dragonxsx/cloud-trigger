import type { JobId } from '@cloud-trigger/core';
import { silentLogger } from '@cloud-trigger/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { type RunLifecycleListener, SlaMonitor } from '../src/index.js';
import { useHarness } from './harness.js';

const h = useHarness('sla');

const HookBody = z.object({
  event: z.string(),
  run: z.object({ id: z.string().nullable() }),
  lateReasons: z.array(z.string()),
});
const lateHooks = () =>
  h.requests
    .filter((r) => r.path.startsWith('/hook'))
    .map((r) => HookBody.parse(JSON.parse(r.body)))
    .filter((b) => b.event === 'late');
const lateRule = () => ({
  on: ['late'],
  notifier: { type: 'webhook', config: { url: `${h.base()}/hook` } },
});
const monitor = (listeners: readonly RunLifecycleListener[] = h.listeners()) =>
  new SlaMonitor(
    {
      ...h.db,
      enqueuer: h.enqueuer(),
      clock: h.clock,
      logger: silentLogger,
      listeners,
    },
    { intervalMs: 1_000, batchSize: 50 },
  );
const drain = async () => {
  const dispatcher = h.dispatcher();
  let more = true;
  while (more) {
    more = await dispatcher.tick();
  }
};
const fire = async (jobId: JobId) => {
  const job = await h.db.jobs.get(jobId);
  if (!job?.schedule.nextFireAt) {
    throw new Error('job not scheduled');
  }
  h.setNow(job.schedule.nextFireAt);
  await h.scheduler().tick();
};
const onlyRun = async (jobId: JobId) => {
  const [run] = (await h.db.runs.list({ limit: 1, jobId })).items;
  if (!run) {
    throw new Error('expected a run');
  }

  return run;
};

describe('SLA monitor', () => {
  it('sends exactly one late notification for a run that overruns maxDurationMs', async () => {
    h.route('/slow-target', () => ({ status: 200, delayMs: 800 }));
    const job = await h.createJob('/slow-target', {
      notifications: [lateRule()],
      policy: { sla: { maxDurationMs: 500 } },
    });
    await fire(job.id);
    let lateCalls = 0;
    const listeners = [
      ...h.listeners(),
      {
        onRunFinished: async () => {},
        onRunLate: async () => {
          lateCalls += 1;
        },
      },
    ];
    const worker = h.worker({}, { listeners });
    const settled = h.settle(worker);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await onlyRun(job.id)).status).toBe('running');

    const sla = monitor(listeners);
    await sla.tick();
    expect((await onlyRun(job.id)).late).toBe(false);
    h.advance(600);
    await sla.tick();
    await sla.tick();
    await settled;
    await sla.tick();
    await drain();

    const run = await onlyRun(job.id);
    expect(run).toMatchObject({ status: 'succeeded', late: true });
    expect(run.lateReasons).toEqual(['Still running after 500 ms']);
    expect(lateHooks()).toHaveLength(1);
    expect(lateHooks()[0]?.run.id).toBe(run.id);
    expect(lateCalls).toBe(1);
  });

  it('flags an overrun that finishes before the monitor checks it', async () => {
    h.route('/slow-target', () => ({ status: 200, delayMs: 300 }));
    const job = await h.createJob('/slow-target', {
      notifications: [lateRule()],
      policy: { sla: { maxDurationMs: 500 } },
    });
    await fire(job.id);
    const settled = h.settle(h.worker());
    await new Promise((resolve) => setTimeout(resolve, 100));
    h.advance(600);
    await settled;
    await drain();

    const run = await onlyRun(job.id);
    expect(run).toMatchObject({ status: 'succeeded', late: true });
    expect(run.lateReasons).toEqual(['Still running after 500 ms']);
    expect(lateHooks()).toHaveLength(1);
  });

  it('flags a late start that finishes before the monitor checks it', async () => {
    const job = await h.createJob('/ok', {
      notifications: [lateRule()],
      policy: { sla: { maxStartDelayMs: 1_000 } },
    });
    await fire(job.id);
    h.advance(1_500);
    await h.settle(h.worker());
    await drain();

    const run = await onlyRun(job.id);
    expect(run).toMatchObject({ status: 'succeeded', late: true });
    expect(run.lateReasons).toEqual(['Started 1500 ms after its scheduled time']);
    expect(lateHooks()).toHaveLength(1);
  });

  it('leaves a run that finishes within its limits on time', async () => {
    const job = await h.createJob('/ok', {
      notifications: [lateRule()],
      policy: { sla: { maxStartDelayMs: 1_000, maxDurationMs: 5_000 } },
    });
    await fire(job.id);
    await h.settle(h.worker());
    await drain();

    expect(await onlyRun(job.id)).toMatchObject({ status: 'succeeded', late: false });
    expect(lateHooks()).toHaveLength(0);
  });

  it('flags a run that waited longer than maxStartDelayMs only once', async () => {
    const job = await h.createJob('/ok', {
      notifications: [lateRule()],
      policy: { sla: { maxStartDelayMs: 1_000, maxDurationMs: 60_000 } },
    });
    await fire(job.id);
    h.advance(1_500);
    await monitor().tick();
    expect((await onlyRun(job.id)).lateReasons).toEqual([
      'Not started within 1000 ms of its scheduled time',
    ]);
    await h.settle(h.worker());
    h.advance(120_000);
    await monitor().tick();
    await drain();

    expect(await onlyRun(job.id)).toMatchObject({ status: 'succeeded', late: true });
    expect(lateHooks()).toHaveLength(1);
  });

  it('flags a job without a recent success and clears it on the next success', async () => {
    const job = await h.createJob('/ok', {
      notifications: [lateRule()],
      policy: { sla: { maxSinceLastSuccessMs: 30_000 } },
    });
    h.advance(31_000);
    await monitor().tick();
    await monitor().tick();
    await drain();
    expect((await h.db.jobs.get(job.id))?.slaBreachedAt).toEqual(h.now());
    expect(lateHooks()).toHaveLength(1);
    expect(lateHooks()[0]).toMatchObject({ run: { id: null } });

    await h.service().runNow(job.id);
    await h.settle(h.worker());
    const recovered = await h.db.jobs.get(job.id);
    expect(recovered?.slaBreachedAt).toBeNull();
    expect(recovered?.schedule.successDeadline).toEqual(new Date(h.now().getTime() + 30_000));
  });
});
