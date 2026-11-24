import {
  EnvironmentSpec,
  type WorkflowRepository,
  createEnvironment,
  newEnvironmentId,
  silentLogger,
} from '@cloud-trigger/core';
import { describe, expect, it } from 'vitest';

import { type Worker, WorkflowMonitor } from '../src/index.js';
import { useHarness } from './harness.js';

const h = useHarness('workflows');

const drain = async (worker: Worker, rounds = 6) => {
  for (let i = 0; i < rounds; i++) {
    await worker.tick();
    await worker.stop();
  }
};

const inline = (key: string, path: string, extra: Record<string, unknown> = {}) => ({
  key,
  kind: 'inline',
  job: {
    target: { type: 'http', config: { method: 'POST', url: `${h.base()}${path}` } },
    ...extra,
  },
});

const statuses = async (id: Parameters<ReturnType<typeof h.workflows>['getRun']>[0]) => {
  const run = (await h.workflows().getRun(id))._unsafeUnwrap();

  return {
    status: run.status,
    nodes: Object.fromEntries(Object.entries(run.nodes).map(([key, node]) => [key, node.status])),
  };
};

const issues = async (spec: Record<string, unknown>) => {
  const result = await h.workflows().create({ name: 'bad', ...spec });

  return result.isErr() && result.error.code === 'invalid_config'
    ? result.error.issues.map((issue) => issue.path)
    : [];
};

describe('DAG workflows', () => {
  it('runs a release pipeline with an approval gate and a failure branch', async () => {
    h.route('/deploy', () => ({ status: 500 }));
    const build = await h.createJob('/build');
    const workflow = (
      await h.workflows().create({
        name: 'release',
        nodes: [
          { key: 'build', kind: 'job', jobId: build.id },
          inline('test', '/test', {
            input: { type: 'template', config: { template: 'after {{ parent.jobName }}' } },
          }),
          { key: 'approve', kind: 'approval', timeoutMs: 60_000 },
          inline('deploy', '/deploy'),
          inline('rollback', '/rollback'),
        ],
        edges: [
          { from: 'build', to: 'test' },
          { from: 'test', to: 'approve' },
          { from: 'approve', to: 'deploy' },
          { from: 'deploy', to: 'rollback', on: 'failed' },
        ],
      })
    )._unsafeUnwrap();
    expect(Object.keys(workflow.inlineJobIds)).toEqual(['test', 'deploy', 'rollback']);
    const owned = await h.db.jobs.get(workflow.inlineJobIds['test'] ?? build.id);
    expect(owned).toMatchObject({ workflowId: workflow.id, trigger: { type: 'manual' } });
    expect(owned?.schedule.nextFireAt).toBeNull();

    const run = (await h.workflows().start(workflow.id))._unsafeUnwrap();
    expect(await statuses(run.id)).toMatchObject({ nodes: { build: 'queued', test: 'pending' } });
    const [buildRun] = (await h.db.runs.list({ limit: 5, jobId: build.id })).items;
    expect(buildRun).toMatchObject({
      reason: 'workflow',
      idempotencyKey: `wf:${run.id}:build`,
      workflow: { runId: run.id, node: 'build' },
    });

    await drain(h.worker());
    expect(await statuses(run.id)).toMatchObject({
      status: 'running',
      nodes: { build: 'succeeded', test: 'succeeded', approve: 'waiting_approval' },
    });
    expect(h.requests.find((r) => r.path === '/test')?.body).toBe(`after ${build.name}`);

    expect(
      (await h.workflows().decide(run.id, 'deploy', { approved: true, by: 'x' }))._unsafeUnwrapErr()
        .code,
    ).toBe('conflict');
    const approved = await h.workflows().decide(run.id, 'approve', { approved: true, by: 'alice' });
    expect(approved._unsafeUnwrap().nodes['approve']).toMatchObject({ decidedBy: 'alice' });

    await drain(h.worker());
    expect(await statuses(run.id)).toEqual({
      status: 'succeeded',
      nodes: {
        build: 'succeeded',
        test: 'succeeded',
        approve: 'succeeded',
        deploy: 'failed',
        rollback: 'succeeded',
      },
    });
  });

  it('fails a gate after its timeout and skips what follows', async () => {
    const workflow = (
      await h.workflows().create({
        name: 'gated',
        nodes: [{ key: 'gate', kind: 'approval', timeoutMs: 5_000 }, inline('after', '/after')],
        edges: [{ from: 'gate', to: 'after' }],
      })
    )._unsafeUnwrap();
    const run = (await h.workflows().start(workflow.id))._unsafeUnwrap();
    await h.workflowMonitor().tick();
    expect((await statuses(run.id)).nodes['gate']).toBe('waiting_approval');
    h.advance(5_000);
    await h.workflowMonitor().tick();
    expect(await statuses(run.id)).toEqual({
      status: 'failed',
      nodes: { gate: 'failed', after: 'skipped' },
    });
  });

  it('fires scheduled workflows exactly once across monitors', async () => {
    const workflow = (
      await h.workflows().create({
        name: 'nightly',
        schedule: { type: 'interval', config: { every: 1, unit: 'minutes' } },
        nodes: [inline('only', '/nightly')],
      })
    )._unsafeUnwrap();
    expect(workflow.nextFireAt).not.toBeNull();
    h.advance(60_000);
    await Promise.all([
      h.workflowMonitor().tick(),
      h.workflowMonitor().tick(),
      h.workflowMonitor().tick(),
    ]);
    const runs = await h.workflows().listRuns({ limit: 10, workflowId: workflow.id });
    expect(runs.items).toHaveLength(1);
    expect(runs.items[0]?.reason).toBe('scheduled');
    expect(runs.items[0]?.idempotencyKey).toMatch(/^wfsched:/);
  });

  it('stops an interval workflow after maxCount fires', async () => {
    const workflow = (
      await h.workflows().create({
        name: 'twice',
        schedule: { type: 'interval', config: { every: 1, unit: 'minutes', maxCount: 2 } },
        nodes: [inline('only', '/twice')],
      })
    )._unsafeUnwrap();
    for (let i = 0; i < 3; i++) {
      h.advance(60_000);
      await h.workflowMonitor().tick();
    }
    const runs = await h.workflows().listRuns({ limit: 10, workflowId: workflow.id });
    expect(runs.items).toHaveLength(2);
    expect((await h.workflows().get(workflow.id))._unsafeUnwrap()).toMatchObject({
      nextFireAt: null,
      fireCount: 2,
    });
  });

  it('keeps the next fire time when an edit leaves the schedule alone', async () => {
    const spec = {
      name: 'nightly',
      schedule: { type: 'interval', config: { every: 1, unit: 'minutes' } },
      nodes: [inline('only', '/nightly')],
    };
    const created = (await h.workflows().create(spec))._unsafeUnwrap();
    h.advance(60_000);
    await h.workflowMonitor().tick();
    const fired = (await h.workflows().get(created.id))._unsafeUnwrap();
    h.advance(30_000);
    const renamed = (
      await h.workflows().update(created.id, { ...spec, name: 'renamed' }, fired.version)
    )._unsafeUnwrap();
    expect(renamed).toMatchObject({
      name: 'renamed',
      nextFireAt: fired.nextFireAt,
      fireCount: 1,
    });
  });

  it('keeps a scheduled occurrence when firing it fails once', async () => {
    const workflow = (
      await h.workflows().create({
        name: 'flaky store',
        schedule: { type: 'interval', config: { every: 1, unit: 'minutes' } },
        nodes: [inline('only', '/flaky')],
      })
    )._unsafeUnwrap();
    let failures = 1;
    const workflows: WorkflowRepository = {
      ...h.db.workflows,
      findDue: (p) => h.db.workflows.findDue(p),
      fireSchedule: async (fire) => {
        if (failures-- > 0) {
          throw new Error('store unavailable');
        }

        return h.db.workflows.fireSchedule(fire);
      },
    };
    const monitor = new WorkflowMonitor(
      {
        ...h.db,
        workflows,
        registry: h.registry,
        clock: h.clock,
        logger: silentLogger,
        runtime: h.workflowRuntime(),
      },
      { intervalMs: 1_000, batchSize: 50 },
    );
    h.advance(60_000);
    await monitor.tick();
    expect((await h.workflows().get(workflow.id))._unsafeUnwrap().nextFireAt).toEqual(
      workflow.nextFireAt,
    );
    await monitor.tick();
    const runs = await h.workflows().listRuns({ limit: 10, workflowId: workflow.id });
    expect(runs.items).toHaveLength(1);
  });

  it('does not fire a workflow disabled after it was found due', async () => {
    const spec = {
      name: 'switched off',
      schedule: { type: 'interval', config: { every: 1, unit: 'minutes' } },
      nodes: [inline('only', '/off')],
    };
    const workflow = (await h.workflows().create(spec))._unsafeUnwrap();
    const workflows: WorkflowRepository = {
      ...h.db.workflows,
      findDue: async (p) => {
        const due = await h.db.workflows.findDue(p);
        await h.workflows().update(workflow.id, { ...spec, enabled: false }, workflow.version);

        return due;
      },
      fireSchedule: (fire) => h.db.workflows.fireSchedule(fire),
    };
    const monitor = new WorkflowMonitor(
      {
        ...h.db,
        workflows,
        registry: h.registry,
        clock: h.clock,
        logger: silentLogger,
        runtime: h.workflowRuntime(),
      },
      { intervalMs: 1_000, batchSize: 50 },
    );
    h.advance(60_000);
    await monitor.tick();
    const runs = await h.workflows().listRuns({ limit: 10, workflowId: workflow.id });
    expect(runs.items).toEqual([]);
  });

  it('passes its environment to inline jobs that set none', async () => {
    for (const key of ['staging', 'prod']) {
      await h.db.environments.insert(
        createEnvironment({
          id: newEnvironmentId(),
          spec: EnvironmentSpec.parse({ key }),
          now: h.now(),
        }),
      );
    }
    const workflow = (
      await h.workflows().create({
        name: 'staged',
        environment: 'staging',
        nodes: [inline('inherits', '/a'), inline('own', '/b', { environment: 'prod' })],
      })
    )._unsafeUnwrap();
    const environmentOf = async (key: string) => {
      const id = workflow.inlineJobIds[key];

      return id === undefined ? undefined : (await h.db.jobs.get(id))?.environment;
    };
    expect(await environmentOf('inherits')).toBe('staging');
    expect(await environmentOf('own')).toBe('prod');
    const unknown = await h.workflows().create({
      name: 'nowhere',
      environment: 'qa',
      nodes: [inline('a', '/a')],
    });
    expect(unknown._unsafeUnwrapErr()).toMatchObject({ issues: [{ path: 'environment' }] });
  });

  it('cancels a running workflow and its pending node runs', async () => {
    const workflow = (
      await h
        .workflows()
        .create({ name: 'cancel me', nodes: [inline('a', '/a'), inline('b', '/b')] })
    )._unsafeUnwrap();
    const run = (await h.workflows().start(workflow.id))._unsafeUnwrap();
    const cancelled = (await h.workflows().cancel(run.id))._unsafeUnwrap();
    expect(cancelled.status).toBe('cancelled');
    const nodeRuns = await h.db.runs.list({
      limit: 10,
      jobId: workflow.inlineJobIds['a'],
    });
    expect(nodeRuns.items.map((r) => r.status)).toEqual(['cancelled']);
    expect((await h.workflows().cancel(run.id))._unsafeUnwrapErr().code).toBe('conflict');
  });

  it('re-creates a node run lost between the state write and the insert', async () => {
    const workflow = (
      await h.workflows().create({ name: 'repair', nodes: [inline('a', '/repaired')] })
    )._unsafeUnwrap();
    const run = (await h.workflows().start(workflow.id))._unsafeUnwrap();
    await h.clear(['runs', 'fire_keys']);
    await h.workflowMonitor().tick();
    await drain(h.worker(), 2);
    expect((await statuses(run.id)).status).toBe('succeeded');
  });

  it('repairs lost node runs beyond the first batch', async () => {
    const started = [];
    for (const name of ['one', 'two', 'three']) {
      const workflow = (
        await h.workflows().create({ name, nodes: [inline('a', `/repair-${name}`)] })
      )._unsafeUnwrap();
      started.push((await h.workflows().start(workflow.id))._unsafeUnwrap());
    }
    await h.clear(['runs', 'fire_keys']);
    const monitor = h.workflowMonitor({ batchSize: 1 });
    for (let i = 0; i < 3; i++) {
      await monitor.tick();
    }
    await drain(h.worker(), 3);
    for (const run of started) {
      expect((await statuses(run.id)).status).toBe('succeeded');
    }
  });

  it('validates graphs, job references, schedules and inline jobs', async () => {
    expect(
      await issues({
        nodes: [
          { key: 'a', kind: 'approval' },
          { key: 'b', kind: 'approval' },
        ],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' },
        ],
      }),
    ).toEqual(['edges']);
    expect(
      await issues({
        nodes: [{ key: 'a', kind: 'job', jobId: '0190a000-0000-7000-8000-000000000009' }],
      }),
    ).toEqual(['nodes.0.jobId']);
    expect(
      await issues({
        nodes: [{ key: 'a', kind: 'approval' }],
        schedule: { type: 'after_job', config: { jobId: '0190a000-0000-7000-8000-000000000009' } },
      }),
    ).toEqual(['schedule.type']);
    expect(
      await issues({
        nodes: [{ key: 'a', kind: 'inline', job: { target: { type: 'http', config: {} } } }],
      }),
    ).toEqual(['nodes.0.job.target.config.url']);
  });

  it('keeps inline jobs in sync and protects them from direct edits', async () => {
    const service = h.workflows();
    const workflow = (
      await service.create({ name: 'sync', nodes: [inline('a', '/a'), inline('b', '/b')] })
    )._unsafeUnwrap();
    const a = workflow.inlineJobIds['a'];
    const b = workflow.inlineJobIds['b'];
    if (!a || !b) {
      throw new Error('inline jobs missing');
    }
    expect((await h.service().delete(a))._unsafeUnwrapErr().code).toBe('conflict');

    const updated = (
      await service.update(
        workflow.id,
        { name: 'sync', nodes: [inline('a', '/a2'), inline('c', '/c')] },
        workflow.version,
      )
    )._unsafeUnwrap();
    expect(updated.inlineJobIds['a']).toBe(a);
    expect(await h.db.jobs.get(b)).toBeUndefined();
    expect((await h.db.jobs.get(a))?.target.config).toMatchObject({ url: `${h.base()}/a2` });

    expect(await service.delete(workflow.id)).toBe(true);
    expect(await h.db.jobs.get(a)).toBeUndefined();
  });
});
