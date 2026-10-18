import type { JobSpec } from '@cloud-trigger/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { GroupService, JobTransfer } from '../src/index.js';
import { useHarness } from './harness.js';

const h = useHarness('operations');

const hourly = { type: 'cron', config: { expression: '0 * * * *', timezone: 'UTC' } };
const day = { from: new Date('2026-02-01T00:00:00Z'), to: new Date('2026-02-01T05:00:00Z') };

describe('backfill', () => {
  it('previews, inserts idempotently and caps the run count', async () => {
    const job = await h.createJob('/ok', {
      trigger: hourly,
      policy: { sla: { maxStartDelayMs: 1_000 } },
    });
    const preview = await h.service().backfill(job.id, { ...day, maxRuns: 1_000, dryRun: true });
    expect(preview._unsafeUnwrap()).toMatchObject({ created: [], duplicates: 0, truncated: false });
    expect(preview._unsafeUnwrap().fireTimes.map((t) => t.toISOString())).toEqual([
      '2026-02-01T00:00:00.000Z',
      '2026-02-01T01:00:00.000Z',
      '2026-02-01T02:00:00.000Z',
      '2026-02-01T03:00:00.000Z',
      '2026-02-01T04:00:00.000Z',
      '2026-02-01T05:00:00.000Z',
    ]);
    expect((await h.db.runs.list({ limit: 10, jobId: job.id })).total).toBe(0);

    const first = (
      await h.service().backfill(job.id, { ...day, maxRuns: 4, dryRun: false })
    )._unsafeUnwrap();
    expect(first).toMatchObject({ duplicates: 0, truncated: true });
    expect(first.created).toHaveLength(4);
    const again = (
      await h.service().backfill(job.id, { ...day, maxRuns: 1_000, dryRun: false })
    )._unsafeUnwrap();
    expect(again.created).toHaveLength(2);
    expect(again.duplicates).toBe(4);

    const runs = (await h.db.runs.list({ limit: 20, jobId: job.id })).items;
    expect(runs).toHaveLength(6);
    expect(runs.every((r) => r.reason === 'backfill' && r.slaDeadline === null)).toBe(true);
    for (let round = 0; round < 6; round++) {
      await h.settle(h.worker({ concurrency: 6 }));
      h.advance(1_000);
    }
    expect((await h.db.runs.list({ limit: 1, jobId: job.id, status: ['skipped'] })).total).toBe(0);
    expect((await h.db.runs.list({ limit: 1, jobId: job.id, status: ['succeeded'] })).total).toBe(
      6,
    );
  });

  it('never re-inserts a backfilled occurrence after its run is pruned', async () => {
    const job = await h.createJob('/ok', {
      trigger: hourly,
      policy: { history: { keepSucceeded: 0 } },
    });
    const range = { ...day, maxRuns: 1_000, dryRun: false };
    expect((await h.service().backfill(job.id, range))._unsafeUnwrap().created).toHaveLength(6);
    for (let round = 0; round < 6; round++) {
      await h.settle(h.worker({ concurrency: 6 }));
      h.advance(1_000);
    }
    expect((await h.db.runs.list({ limit: 10, jobId: job.id })).total).toBe(0);

    const again = (await h.service().backfill(job.id, range))._unsafeUnwrap();
    expect(again).toMatchObject({ created: [], duplicates: 6 });
  });

  it('rejects inverted ranges and event-triggered jobs', async () => {
    const job = await h.createJob('/ok', { trigger: hourly });
    const inverted = await h
      .service()
      .backfill(job.id, { from: day.to, to: day.from, maxRuns: 10, dryRun: true });
    expect(inverted._unsafeUnwrapErr()).toMatchObject({ code: 'invalid_config' });
    const chained = await h.createJob('/ok', {
      trigger: { type: 'after_job', config: { jobId: job.id } },
    });
    const refused = await h.service().backfill(chained.id, { ...day, maxRuns: 10, dryRun: true });
    expect(refused._unsafeUnwrapErr()).toMatchObject({ code: 'invalid_config' });
  });
});

describe('explain', () => {
  it('records overlap skips and auto-pauses and narrates them', async () => {
    h.route('/busy', () => ({ status: 200, delayMs: 300 }));
    const busy = await h.createJob('/busy');
    await h.service().runNow(busy.id);
    await h.service().runNow(busy.id);
    await h.settle(h.worker());
    const overlap = (await h.service().explain(busy.id))._unsafeUnwrap();
    expect(overlap.decisions.map((d) => d.decision)).toEqual(['overlap_skipped']);
    expect(overlap.narrative.at(-1)).toContain(
      'was skipped because the previous run was still active',
    );

    const flaky = await h.createJob('/fail', { policy: { pauseAfterConsecutiveFailures: 2 } });
    for (let i = 0; i < 2; i++) {
      await h.service().runNow(flaky.id);
      await h.settle(h.worker());
    }
    const paused = (await h.service().explain(flaky.id))._unsafeUnwrap();
    expect(paused.decisions[0]).toMatchObject({ decision: 'paused' });
    expect(paused.narrative[0]).toMatch(
      /^Paused since .* UTC: Auto-paused after 2 consecutive failures\. Resume it to schedule runs again\. Its next fire would be /,
    );
    expect(paused.narrative[1]).toBe('The last 2 run(s) failed in a row.');
  });

  it('records skipped misfires and an exhausted schedule', async () => {
    const once = await h.createJob('/ok', {
      trigger: { type: 'once', config: { at: '2026-03-01T00:01:00Z' } },
      policy: { misfire: { mode: 'skip', graceMs: 1_000 } },
    });
    h.setNow(new Date('2026-03-01T00:10:00Z'));
    await h.scheduler().tick();
    const result = (await h.service().explain(once.id))._unsafeUnwrap();
    expect(result.decisions.map((d) => d.decision).toSorted()).toEqual([
      'finished',
      'misfire_skipped',
    ]);
    expect(result.narrative[0]).toBe(
      'Its schedule has no further fire times, so it will not run again.',
    );
  });
});

const transfer = () => new JobTransfer({ ...h.db, registry: h.registry, service: h.service() });
const keep = { restore: (next: JobSpec) => next };
const roundTrip = (docs: unknown): unknown[] =>
  z.array(z.unknown()).parse(JSON.parse(JSON.stringify(docs)));

describe('YAML transfer', () => {
  it('exports by name, re-imports into an empty environment, and is idempotent', async () => {
    const group = (
      await new GroupService({ ...h.db, registry: h.registry, clock: h.clock }).create({
        name: 'etl',
      })
    )._unsafeUnwrap();
    const extract = await h.createJob('/ok', {
      name: 'extract',
      groupId: group.id,
      trigger: hourly,
    });
    await h.createJob('/ok', {
      name: 'load',
      trigger: { type: 'after_job', config: { jobId: extract.id } },
    });

    const exported = await transfer().export({}, (job) => job);
    expect(exported.map((d) => [d.name, d.group, d.upstream])).toEqual([
      ['extract', 'etl', {}],
      ['load', null, { jobId: 'extract' }],
    ]);
    const docs = roundTrip(exported);

    for (const job of (await h.db.jobs.list({ limit: 10 })).items) {
      await h.service().delete(job.id);
    }
    const dry = await transfer().import(docs, { mode: 'upsert', dryRun: true, ...keep });
    expect(dry).toMatchObject({ created: ['extract', 'load'], issues: [] });
    expect((await h.db.jobs.list({ limit: 10 })).total).toBe(0);

    const applied = await transfer().import(docs, { mode: 'upsert', dryRun: false, ...keep });
    expect(applied).toMatchObject({ created: ['extract', 'load'], updated: [], issues: [] });
    const [newExtract] = await h.db.jobs.findByName('extract');
    const [newLoad] = await h.db.jobs.findByName('load');
    expect(newExtract?.groupId).toBe(group.id);
    expect(newLoad?.upstreamJobIds).toEqual([newExtract?.id]);

    const again = await transfer().import(docs, { mode: 'upsert', dryRun: false, ...keep });
    expect(again).toMatchObject({ created: [], updated: [], unchanged: ['extract', 'load'] });
  });

  it('updates changed jobs, deletes extras in replace mode and refuses invalid files', async () => {
    await h.createJob('/ok', { name: 'keep', trigger: hourly });
    await h.createJob('/ok', { name: 'drop', trigger: hourly });
    const [keepDoc] = roundTrip(await transfer().export({}, (job) => job)).filter(
      (d) => z.object({ name: z.string() }).parse(d).name === 'keep',
    );
    const changed = { ...z.record(z.string(), z.unknown()).parse(keepDoc), description: 'edited' };

    const preview = await transfer().import([changed], { mode: 'replace', dryRun: true, ...keep });
    expect(preview).toMatchObject({ updated: ['keep'], deleted: ['drop'] });
    expect((await h.db.jobs.findByName('drop')).length).toBe(1);
    await transfer().import([changed], { mode: 'replace', dryRun: false, ...keep });
    expect((await h.db.jobs.findByName('keep'))[0]?.description).toBe('edited');
    expect(await h.db.jobs.findByName('drop')).toEqual([]);

    const invalid = await transfer().import(
      [
        changed,
        { ...changed, name: 'broken', trigger: { type: 'cron', config: { expression: 'nope' } } },
      ],
      { mode: 'upsert', dryRun: false, ...keep },
    );
    expect(invalid.issues).toEqual([
      {
        document: 1,
        name: 'broken',
        path: 'trigger.config.expression',
        message: 'Invalid cron expression',
      },
    ]);
    expect(await h.db.jobs.findByName('broken')).toEqual([]);
    const secretless = await transfer().import(
      [
        {
          ...changed,
          name: 'fresh',
          target: { type: 'http', config: { url: 'https://x', secretHeaders: { a: '***' } } },
        },
      ],
      { mode: 'upsert', dryRun: true, ...keep },
    );
    expect(secretless.issues.map((i) => i.path)).toEqual(['secrets']);
  });

  it('refuses an upstream cycle before writing or deleting anything', async () => {
    const existing = await h.createJob('/ok', { name: 'existing', trigger: hourly });
    const chained = (name: string, upstream: string) => ({
      name,
      target: { type: 'http', config: { url: 'https://x' } },
      trigger: { type: 'after_job', config: { jobId: existing.id } },
      upstream: { jobId: upstream },
    });
    const docs = [chained('a', 'b'), chained('b', 'a')];
    for (const dryRun of [true, false]) {
      const result = await transfer().import(docs, { mode: 'replace', dryRun, ...keep });
      expect(result.issues.map((i) => [i.name, i.message])).toEqual([
        ['a', 'Upstream jobs form a cycle'],
        ['b', 'Upstream jobs form a cycle'],
      ]);
      expect(result.deleted).toEqual([]);
    }
    expect((await h.db.jobs.list({ limit: 10 })).items.map((j) => j.name)).toEqual(['existing']);
  });
});
