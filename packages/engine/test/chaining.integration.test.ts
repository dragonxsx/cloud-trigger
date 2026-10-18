import { silentLogger } from '@cloud-trigger/core';
import { describe, expect, it } from 'vitest';

import { ChainListener } from '../src/index.js';
import { useHarness } from './harness.js';

const h = useHarness('chaining');

const issuesOf = (result: { _unsafeUnwrapErr: () => object }) => {
  const error = result._unsafeUnwrapErr();

  return 'issues' in error && Array.isArray(error.issues)
    ? error.issues.map((issue: unknown) => JSON.stringify(issue))
    : [];
};

const afterJob = (jobId: string, on: readonly string[] = ['succeeded']) => ({
  type: 'after_job',
  config: { jobId, on },
});

describe('job chaining', () => {
  it('runs a dependant after its parent and passes the parent result to its input', async () => {
    h.route('/parent', () => ({ status: 201 }));
    const parent = await h.createJob('/parent');
    const child = await h.createJob('/child', {
      trigger: afterJob(parent.id),
      input: {
        type: 'template',
        config: { template: 'parent status {{ parent.result.statusCode }}' },
      },
      target: { type: 'http', config: { method: 'POST', url: `${h.base()}/child` } },
    });
    expect(child.upstreamJobIds).toEqual([parent.id]);
    expect(child.schedule.nextFireAt).toBeNull();

    await h.service().runNow(parent.id);
    await h.settle(h.worker());
    const [chained] = (await h.db.runs.list({ limit: 5, jobId: child.id })).items;
    expect(chained).toMatchObject({ reason: 'chained', status: 'pending' });
    await h.settle(h.worker());

    expect(h.requests.find((r) => r.path === '/child')?.body).toBe('parent status 201');
    const deps = await h.service().dependencies(parent.id);
    expect(deps.downstream.map((j) => j.id)).toEqual([child.id]);
    expect((await h.service().dependencies(child.id)).upstream.map((j) => j.id)).toEqual([
      parent.id,
    ]);
  });

  it('keeps the parent context after its run is pruned and when the child is replayed', async () => {
    h.route('/pruned', () => ({ status: 202 }));
    const parent = await h.createJob('/pruned', { policy: { history: { keepSucceeded: 0 } } });
    const child = await h.createJob('/child-kept', {
      trigger: afterJob(parent.id),
      input: { type: 'template', config: { template: 'parent {{ parent.result.statusCode }}' } },
      target: { type: 'http', config: { method: 'POST', url: `${h.base()}/child-kept` } },
    });

    await h.service().runNow(parent.id);
    await h.settle(h.worker());
    expect((await h.db.runs.list({ limit: 5, jobId: parent.id })).total).toBe(0);
    await h.settle(h.worker());
    const [chained] = (await h.db.runs.list({ limit: 5, jobId: child.id })).items;
    if (!chained) {
      throw new Error('expected a chained run');
    }

    (await h.service().replay(chained.id))._unsafeUnwrap();
    await h.settle(h.worker());
    expect(h.requests.filter((r) => r.path === '/child-kept').map((r) => r.body)).toEqual([
      'parent 202',
      'parent 202',
    ]);
  });

  it('starts each dependant once per parent run and respects the outcome filter', async () => {
    const parent = await h.createJob('/fail');
    const onSuccess = await h.createJob('/ok', { trigger: afterJob(parent.id) });
    const onFailure = await h.createJob('/ok', { trigger: afterJob(parent.id, ['failed']) });
    await h.service().runNow(parent.id);
    await h.settle(h.worker());
    const [parentRun] = (await h.db.runs.list({ limit: 1, jobId: parent.id })).items;
    if (!parentRun || parentRun.status !== 'failed') {
      throw new Error('expected a failed parent run');
    }
    await new ChainListener({
      ...h.db,
      registry: h.registry,
      clock: h.clock,
      logger: silentLogger,
    }).onRunFinished(parentRun, parent);

    expect((await h.db.runs.list({ limit: 5, jobId: onSuccess.id })).total).toBe(0);
    const failureRuns = await h.db.runs.list({ limit: 5, jobId: onFailure.id });
    expect(failureRuns.total).toBe(1);
    expect(failureRuns.items[0]?.idempotencyKey).toBe(`chain:${parentRun.id}:${onFailure.id}`);
  });

  it('rejects self references, missing parents and cycles', async () => {
    const a = await h.createJob('/ok');
    const b = await h.createJob('/ok', { trigger: afterJob(a.id) });
    const c = await h.createJob('/ok', { trigger: afterJob(b.id) });
    const spec = { ...a, trigger: { ...afterJob(c.id), jitterMs: 0 } };

    const cycle = await h.service().update(a.id, spec, a.version);
    expect(issuesOf(cycle)).toEqual([
      JSON.stringify({
        path: 'trigger.config.jobId',
        message: `Creates a cycle: "${c.name}" already runs after this job`,
      }),
    ]);
    const self = await h
      .service()
      .update(a.id, { ...a, trigger: { ...afterJob(a.id), jitterMs: 0 } }, a.version);
    expect(issuesOf(self)[0]).toContain('A job cannot run after itself');
    const missing = await h
      .service()
      .update(
        c.id,
        { ...c, trigger: { ...afterJob('01920000-0000-7000-8000-00000000abcd'), jitterMs: 0 } },
        c.version,
      );
    expect(issuesOf(missing)[0]).toContain('does not exist');
  });
});
