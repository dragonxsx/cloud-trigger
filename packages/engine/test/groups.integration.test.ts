import { GroupSpec, createGroup, newGroupId } from '@cloud-trigger/core';
import { describe, expect, it } from 'vitest';

import { GroupService } from '../src/index.js';
import { useHarness } from './harness.js';

const h = useHarness('groups');

const groupService = () => new GroupService({ ...h.db, registry: h.registry, clock: h.clock });

const waitUntil = async (condition: () => Promise<boolean>, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error('timeout');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

describe('groups', () => {
  it('never runs more than maxConcurrent across three worker replicas', async () => {
    h.route('/work', () => ({ status: 200, delayMs: 150 }));
    const group = (
      await groupService().create({ name: 'throttled', rateLimit: { maxConcurrent: 2 } })
    )._unsafeUnwrap();
    const jobs = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        h.createJob('/work', { name: `member ${i}`, groupId: group.id }),
      ),
    );
    for (const job of jobs) {
      await h.service().runNow(job.id);
    }
    const workers = ['w1', 'w2', 'w3'].map((workerId) => h.worker({ workerId, concurrency: 4 }));
    const ticking = setInterval(() => h.advance(50), 50);
    workers.forEach((w) => w.start());
    try {
      await waitUntil(
        async () => (await h.db.runs.list({ limit: 1, status: ['succeeded'] })).total === 10,
      );
    } finally {
      clearInterval(ticking);
      await Promise.all(workers.map((w) => w.stop()));
    }

    expect(h.maxInFlight()).toBe(2);
    expect(await h.db.rateLimiter.listHeld()).toEqual([]);
    const runs = (await h.db.runs.list({ limit: 20 })).items;
    expect(runs.every((r) => r.attempts.length === 1)).toBe(true);
  }, 30_000);

  it('applies group default policies and notifications, with the job winning', async () => {
    const group = (
      await groupService().create({
        name: 'defaults',
        defaultPolicy: { retry: { maxAttempts: 2, backoff: 'fixed', delayMs: 10 } },
        defaultNotifications: [
          {
            on: ['permanent_failure'],
            notifier: { type: 'webhook', config: { url: `${h.base()}/hook` } },
          },
        ],
      })
    )._unsafeUnwrap();
    const inherits = await h.createJob('/fail', { groupId: group.id });
    const overrides = await h.createJob('/fail', {
      groupId: group.id,
      policy: { retry: { maxAttempts: 1 } },
    });
    await h.service().runNow(inherits.id);
    await h.service().runNow(overrides.id);
    for (let i = 0; i < 3; i++) {
      await h.settle(h.worker());
      h.advance(1_000);
    }
    const [inherited] = (await h.db.runs.list({ limit: 1, jobId: inherits.id })).items;
    const [overridden] = (await h.db.runs.list({ limit: 1, jobId: overrides.id })).items;
    expect(inherited).toMatchObject({ status: 'failed', groupId: group.id });
    expect(inherited?.attempts).toHaveLength(2);
    expect(overridden?.attempts).toHaveLength(1);

    await h.drainOutbox();
    expect(h.requests.filter((r) => r.path.startsWith('/hook'))).toHaveLength(2);
  });

  it('rejects unknown groups on jobs and refuses to delete a group with members', async () => {
    const missing = await h.service().create({
      name: 'orphan',
      groupId: newGroupId(),
      trigger: { type: 'interval', config: { every: 1, unit: 'minutes' } },
      target: { type: 'http', config: { url: `${h.base()}/ok` } },
    });
    const [issue] = missing._unsafeUnwrapErr().issues;
    expect(issue?.path).toBe('groupId');
    expect(issue?.message).toContain('does not exist');

    const group = createGroup({
      id: newGroupId(),
      spec: GroupSpec.parse({ name: 'busy' }),
      now: h.now(),
    });
    await h.db.groups.insert(group);
    const member = await h.createJob('/ok', { groupId: group.id });
    expect((await groupService().delete(group.id))._unsafeUnwrapErr().code).toBe('conflict');
    await h.service().delete(member.id);
    expect((await groupService().delete(group.id)).isOk()).toBe(true);
  });

  it('re-arms inherited since-last-success SLAs when the group default changes', async () => {
    const group = (await groupService().create({ name: 'sla' }))._unsafeUnwrap();
    const inherits = await h.createJob('/ok', { groupId: group.id });
    const overrides = await h.createJob('/ok', {
      groupId: group.id,
      policy: { sla: { maxSinceLastSuccessMs: 5_000 } },
    });
    const own = (await h.db.jobs.get(overrides.id))?.schedule.successDeadline;
    expect(inherits.schedule.successDeadline).toBeNull();

    const withSla = (
      await groupService().update(
        group.id,
        { name: 'sla', defaultPolicy: { sla: { maxSinceLastSuccessMs: 30_000 } } },
        group.version,
      )
    )._unsafeUnwrap();
    expect((await h.db.jobs.get(inherits.id))?.schedule.successDeadline).toEqual(
      new Date(h.now().getTime() + 30_000),
    );
    expect((await h.db.jobs.get(overrides.id))?.schedule.successDeadline).toEqual(own);

    const breached = await h.db.jobs.get(inherits.id);
    if (!breached) {
      throw new Error('expected the member');
    }
    await h.db.jobs.updateSlaState(breached, { slaBreachedAt: h.now(), successDeadline: null });
    (await groupService().update(group.id, { name: 'sla' }, withSla.version))._unsafeUnwrap();
    const cleared = await h.db.jobs.get(inherits.id);
    expect(cleared?.slaBreachedAt).toBeNull();
    expect(cleared?.schedule.successDeadline).toBeNull();
  });
});
