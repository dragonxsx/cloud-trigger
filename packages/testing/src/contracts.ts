import {
  type ApiKeyRepository,
  type ConnectionRepository,
  ConnectionSpec,
  createConnection,
  newConnectionId,
  type EnvironmentRepository,
  EnvironmentSpec,
  createEnvironment,
  newEnvironmentId,
  type AuthSettingsStore,
  type UserRepository,
  type DecisionLog,
  type EventSourceLeases,
  type WorkflowRepository,
  type UnitOfWork,
  type WorkflowRun,
  type WorkflowRunRepository,
  completeNode,
  type GroupRepository,
  GroupSpec,
  type JobRepository,
  type JobSortField,
  type SortOrder,
  type RateLimiter,
  createGroup,
  newGroupId,
  type NotificationDelivery,
  type NotificationOutbox,
  type RunAnalytics,
  type RunQueue,
  type RunRepository,
  type RunningRun,
  type ScheduleStore,
  finishAttempt,
  RetryPolicy,
} from '@cloud-trigger/core';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  T0,
  at,
  makeApiKey,
  makeAuthSettings,
  makeDelivery,
  makeJob,
  makePendingRun,
  makeUser,
  makeWorkflow,
  makeWorkflowRun,
} from './fixtures.js';

export interface PortsUnderTest {
  readonly jobs: JobRepository;
  readonly connections: ConnectionRepository;
  readonly environments: EnvironmentRepository;
  readonly schedule: ScheduleStore;
  readonly runs: RunRepository;
  readonly queue: RunQueue;
  readonly analytics: RunAnalytics;
  readonly outbox: NotificationOutbox;
  readonly groups: GroupRepository;
  readonly rateLimiter: RateLimiter;
  readonly decisions: DecisionLog;
  readonly eventSources: EventSourceLeases;
  readonly workflows: WorkflowRepository;
  readonly workflowRuns: WorkflowRunRepository;
  readonly unitOfWork: UnitOfWork;
  readonly authSettings: AuthSettingsStore;
  readonly users: UserRepository;
  readonly apiKeys: ApiKeyRepository;
}

const makeGroup = (name: string) =>
  createGroup({ id: newGroupId(), spec: GroupSpec.parse({ name }), now: T0 });

const makeConnection = (key: string, type = 'http') =>
  createConnection({
    id: newConnectionId(),
    spec: ConnectionSpec.parse({
      key,
      type,
      config: { baseUrl: `https://${key}.test` },
      endpoints: [{ key: 'ping', target: { type: 'http', config: { url: '/ping' } } }],
    }),
    now: T0,
  });

const makeEnvironment = (key: string, name = '') =>
  createEnvironment({
    id: newEnvironmentId(),
    spec: EnvironmentSpec.parse({ key, name }),
    now: T0,
  });

const claimOne = async ({ jobs, runs, queue }: PortsUnderTest) => {
  const job = makeJob();
  await jobs.insert(job);
  await runs.insert(makePendingRun(job));
  const running = await queue.claimNext({ workerId: 'w1', now: at(5), leaseMs: 1_000 });
  if (!running) {
    throw new Error('expected a claim');
  }

  return running;
};
const nodeRunId = (run: WorkflowRun, key: string) => {
  const runId = run.nodes[key]?.runId;
  if (!runId) {
    throw new Error(`node ${key} has no run`);
  }

  return runId;
};

const succeed = (running: RunningRun) =>
  finishAttempt(running, {
    result: { outcome: 'success', durationMs: 3 },
    retry: RetryPolicy.parse({}),
    now: at(10),
  });

export function describePersistenceContract(
  name: string,
  setup: { ports: () => PortsUnderTest; reset: () => Promise<void> },
) {
  describe(`${name}: persistence contract`, () => {
    beforeEach(() => setup.reset());

    describe('UnitOfWork', () => {
      it('commits writes made inside a transaction', async () => {
        const { jobs, runs, unitOfWork } = setup.ports();
        const job = makeJob();
        await unitOfWork.transaction(async () => {
          await jobs.insert(job);
          await runs.insert(makePendingRun(job));
        });
        expect(await jobs.get(job.id)).toEqual(job);
      });

      it('rolls every write back when the work throws, if the store is atomic', async ({
        skip,
      }) => {
        const { jobs, unitOfWork } = setup.ports();
        if (!unitOfWork.atomic) {
          skip();

          return;
        }
        const job = makeJob();
        await expect(
          unitOfWork.transaction(async () => {
            await jobs.insert(job);
            throw new Error('abort');
          }),
        ).rejects.toThrow('abort');
        expect(await jobs.get(job.id)).toBeUndefined();
      });
    });

    describe('Workflows', () => {
      it('round-trips, pages, searches and versions workflows', async () => {
        const { workflows } = setup.ports();
        const a = makeWorkflow({ name: 'alpha release' });
        const b = makeWorkflow({ name: 'beta' });
        await workflows.insert(a);
        await workflows.insert(b);
        expect(await workflows.get(a.id)).toEqual(a);
        const page = await workflows.list({ limit: 1 });
        expect(page.items.map((w) => w.name)).toEqual(['beta']);
        expect(page.total).toBe(2);
        expect(
          (await workflows.list({ limit: 1, cursor: page.nextCursor ?? undefined })).items[0]?.id,
        ).toBe(a.id);
        expect((await workflows.list({ limit: 10, search: 'ALPHA' })).items).toHaveLength(1);

        const change = {
          spec: { ...a, name: 'renamed' },
          inlineJobIds: {},
          nextFireAt: at(5),
          updatedAt: at(1),
        };
        const updated = await workflows.update(a.id, change, 1);
        expect(updated._unsafeUnwrap()).toMatchObject({
          name: 'renamed',
          version: 2,
          nextFireAt: at(5),
        });
        expect((await workflows.update(a.id, change, 1))._unsafeUnwrapErr().code).toBe(
          'version_conflict',
        );
        expect((await workflows.update(makeWorkflow().id, change, 1))._unsafeUnwrapErr().code).toBe(
          'not_found',
        );
        expect(await workflows.delete(a.id)).toBe(true);
        expect(await workflows.get(a.id)).toBeUndefined();
      });

      it('finds workflows by their environment', async () => {
        const { workflows } = setup.ports();
        const staged = makeWorkflow({ name: 'staged', environment: 'staging' });
        await workflows.insert(staged);
        await workflows.insert(makeWorkflow({ name: 'base' }));
        const names = async (environment: string) =>
          (await workflows.findByEnvironment(environment)).map((w) => w.name);
        expect(await names('staging')).toEqual(['staged']);
        await workflows.update(
          staged.id,
          {
            spec: { ...staged, environment: 'prod' },
            inlineJobIds: {},
            nextFireAt: null,
            updatedAt: at(1),
          },
          1,
        );
        expect(await names('staging')).toEqual([]);
        expect(await names('prod')).toEqual(['staged']);
      });

      it('finds due workflows and advances each schedule once', async () => {
        const { workflows } = setup.ports();
        const due = makeWorkflow({ name: 'due' }, at(0));
        await workflows.insert(due);
        await workflows.insert(makeWorkflow({ name: 'later' }, at(60_000)));
        await workflows.insert(makeWorkflow({ name: 'off', enabled: false }, at(0)));
        await workflows.insert(makeWorkflow({ name: 'manual' }));
        expect((await workflows.findDue({ now: at(1), limit: 10 })).map((w) => w.name)).toEqual([
          'due',
        ]);
        const advance = () => workflows.advanceSchedule(due.id, { from: at(0), to: at(30_000) });
        const results = await Promise.all([advance(), advance()]);
        expect(results.filter(Boolean)).toHaveLength(1);
        expect((await workflows.get(due.id))?.nextFireAt).toEqual(at(30_000));
        expect(await workflows.findDue({ now: at(1), limit: 10 })).toEqual([]);
      });

      it('keeps an advanced schedule when an update omits nextFireAt', async () => {
        const { workflows } = setup.ports();
        const due = makeWorkflow({ name: 'due' }, at(0));
        await workflows.insert(due);
        expect(await workflows.advanceSchedule(due.id, { from: at(0), to: at(30_000) })).toBe(true);
        const { nextFireAt: _stale, ...spec } = due;
        const updated = await workflows.update(
          due.id,
          { spec: { ...spec, name: 'renamed' }, inlineJobIds: {}, updatedAt: at(1) },
          due.version,
        );
        expect(updated._unsafeUnwrap()).toMatchObject({ name: 'renamed', nextFireAt: at(30_000) });
        expect((await workflows.get(due.id))?.nextFireAt).toEqual(at(30_000));
      });
    });

    describe('Workflow runs', () => {
      it('stores runs, deduplicates by key, and updates with a version check', async () => {
        const { workflowRuns } = setup.ports();
        const workflow = makeWorkflow();
        const run = makeWorkflowRun(workflow, { key: 'wfsched:x:1' });
        expect((await workflowRuns.insert(run)).isOk()).toBe(true);
        expect(await workflowRuns.get(run.id)).toEqual(run);
        const dup = await workflowRuns.insert(makeWorkflowRun(workflow, { key: 'wfsched:x:1' }));
        expect(dup._unsafeUnwrapErr().code).toBe('duplicate_run');
        expect((await workflowRuns.insert(makeWorkflowRun(workflow))).isOk()).toBe(true);
        expect((await workflowRuns.insert(makeWorkflowRun(workflow))).isOk()).toBe(true);

        const advanced = completeNode(run, 'first', 'succeeded', {
          runId: nodeRunId(run, 'first'),
          now: at(10),
        });
        if (!advanced) {
          throw new Error('expected a transition');
        }
        const saved = await workflowRuns.update(advanced.run, 1);
        expect(saved._unsafeUnwrap()).toMatchObject({
          version: 2,
          nodes: { gate: { status: 'waiting_approval' } },
        });
        expect((await workflowRuns.update(advanced.run, 1))._unsafeUnwrapErr().code).toBe(
          'stale_run',
        );

        const page = await workflowRuns.list({
          limit: 10,
          workflowId: workflow.id,
          status: ['running'],
        });
        expect(page.total).toBe(3);
        expect(
          (await workflowRuns.list({ limit: 10, workflowId: makeWorkflow().id })).items,
        ).toEqual([]);
      });

      it('finds expired approval gates and runs with queued nodes', async () => {
        const { workflowRuns } = setup.ports();
        const workflow = makeWorkflow();
        const queued = makeWorkflowRun(workflow);
        await workflowRuns.insert(queued);
        const waiting = completeNode(queued, 'first', 'succeeded', {
          runId: nodeRunId(queued, 'first'),
          now: at(0),
        });
        if (!waiting) {
          throw new Error('expected a transition');
        }
        const other = makeWorkflowRun(workflow);
        await workflowRuns.insert(other);
        await workflowRuns.update({ ...waiting.run, id: other.id }, 1);

        expect((await workflowRuns.findWithQueuedNodes({ limit: 10 })).map((r) => r.id)).toEqual([
          queued.id,
        ]);
        expect(await workflowRuns.findExpiredApprovals({ now: at(500), limit: 10 })).toEqual([]);
        expect(
          (await workflowRuns.findExpiredApprovals({ now: at(1_000), limit: 10 })).map((r) => r.id),
        ).toEqual([other.id]);
      });
    });

    describe('Event sources', () => {
      it('finds jobs with an event source and keeps it across edits', async () => {
        const { jobs } = setup.ports();
        const sourced = { ...makeJob({ name: 'consumer' }, null), eventSource: 'sqs' };
        await jobs.insert(sourced);
        await jobs.insert(makeJob({ name: 'scheduled' }));
        expect((await jobs.findEventSourced()).map((j) => j.name)).toEqual(['consumer']);
        expect((await jobs.get(sourced.id))?.eventSource).toBe('sqs');

        await jobs.update(sourced.id, { spec: sourced, updatedAt: at(1), eventSource: null }, 1);
        expect(await jobs.findEventSourced()).toEqual([]);
      });

      it('leases a source to one owner until it expires or is released', async () => {
        const { eventSources } = setup.ports();
        const claim = (ownerId: string, ms: number) =>
          eventSources.claim({ key: 'job-1', ownerId, now: at(ms), leaseMs: 1_000 });
        expect(await claim('a', 0)).toBe(true);
        expect(await claim('b', 10)).toBe(false);
        expect(await claim('a', 500)).toBe(true);
        expect(await claim('b', 1_400)).toBe(false);
        expect(await claim('b', 1_600)).toBe(true);
        await eventSources.release({ key: 'job-1', ownerId: 'a' });
        expect(await claim('a', 1_700)).toBe(false);
        await eventSources.release({ key: 'job-1', ownerId: 'b' });
        expect(await claim('a', 1_800)).toBe(true);
      });

      it('lets exactly one of several racing owners win', async () => {
        const { eventSources } = setup.ports();
        const results = await Promise.all(
          ['a', 'b', 'c', 'd'].map((ownerId) =>
            eventSources.claim({ key: 'race', ownerId, now: T0, leaseMs: 1_000 }),
          ),
        );
        expect(results.filter(Boolean)).toHaveLength(1);
      });

      it('stores the inbound event on the run', async () => {
        const { jobs, runs } = setup.ports();
        const job = makeJob();
        await jobs.insert(job);
        const event = {
          kind: 'webhook' as const,
          source: 'webhook',
          id: 'delivery-1',
          body: '{"a":1}',
          headers: { 'content-type': 'application/json' },
          receivedAt: T0,
        };
        const run = { ...makePendingRun(job), reason: 'event' as const, event };
        await runs.insert(run);
        expect((await runs.get(run.id))?.event).toEqual(event);
      });
    });

    describe('JobRepository', () => {
      it('round-trips a job and pages newest first', async () => {
        const { jobs } = setup.ports();
        const a = makeJob({ name: 'alpha', tags: ['x'] });
        const b = makeJob({ name: 'beta' });
        await jobs.insert(a);
        await jobs.insert(b);
        expect(await jobs.get(a.id)).toEqual(a);
        const page1 = await jobs.list({ limit: 1 });
        expect(page1.items.map((j) => j.name)).toEqual(['beta']);
        const page2 = await jobs.list({ limit: 1, cursor: page1.nextCursor ?? undefined });
        expect(page2.items.map((j) => j.name)).toEqual(['alpha']);
        expect(page2.nextCursor).toBeNull();
        expect(page1.total).toBe(2);
        const byOffset = await jobs.list({ limit: 1, offset: 1 });
        expect(byOffset.items.map((j) => j.name)).toEqual(['alpha']);
        expect((await jobs.list({ limit: 10, tag: 'x' })).items).toHaveLength(1);
        expect((await jobs.list({ limit: 10, search: 'ALP' })).items).toHaveLength(1);
      });

      it('sorts jobs across pages with nulls last and ties newest first', async () => {
        const { jobs } = setup.ports();
        const seeds = [
          { name: 'bravo', nextFireAt: at(3_000), lastSuccessAt: at(100), failures: 0 },
          { name: 'Alpha', nextFireAt: at(1_000), lastSuccessAt: null, failures: 2 },
          { name: 'charlie', nextFireAt: at(500), lastSuccessAt: at(300), failures: 1 },
          { name: 'Delta', nextFireAt: at(200), lastSuccessAt: at(200), failures: 0 },
          { name: 'echo', nextFireAt: null, lastSuccessAt: null, failures: 0 },
        ];
        for (const seed of seeds) {
          const job = makeJob(
            { name: seed.name, enabled: seed.name !== 'charlie' },
            seed.nextFireAt,
          );
          await jobs.insert(job);
          await jobs.patchSchedule(
            job.id,
            { lastSuccessAt: seed.lastSuccessAt, consecutiveFailures: seed.failures },
            seed.name === 'Delta' ? { pausedReason: 'Paused by user' } : {},
          );
        }
        const names = async (field: JobSortField, order: SortOrder) =>
          (await jobs.list({ limit: 10, sort: { field, order } })).items.map((j) => j.name);

        expect(await names('name', 'asc')).toEqual(['Alpha', 'bravo', 'charlie', 'Delta', 'echo']);
        expect(await names('name', 'desc')).toEqual(['echo', 'Delta', 'charlie', 'bravo', 'Alpha']);
        expect(await names('nextRun', 'asc')).toEqual([
          'Alpha',
          'bravo',
          'echo',
          'Delta',
          'charlie',
        ]);
        expect(await names('nextRun', 'desc')).toEqual([
          'bravo',
          'Alpha',
          'echo',
          'Delta',
          'charlie',
        ]);
        expect(await names('lastSuccess', 'asc')).toEqual([
          'bravo',
          'Delta',
          'charlie',
          'echo',
          'Alpha',
        ]);
        expect(await names('lastSuccess', 'desc')).toEqual([
          'charlie',
          'Delta',
          'bravo',
          'echo',
          'Alpha',
        ]);
        expect(await names('failures', 'asc')).toEqual([
          'echo',
          'Delta',
          'bravo',
          'charlie',
          'Alpha',
        ]);
        expect(await names('failures', 'desc')).toEqual([
          'Alpha',
          'charlie',
          'echo',
          'Delta',
          'bravo',
        ]);

        const page = await jobs.list({
          limit: 2,
          offset: 2,
          sort: { field: 'name', order: 'asc' },
        });
        expect(page.items.map((j) => j.name)).toEqual(['charlie', 'Delta']);
        expect(page.total).toBe(5);
        expect(page.nextCursor).toBeNull();
        const filtered = await jobs.list({
          limit: 10,
          enabled: true,
          sort: { field: 'name', order: 'desc' },
        });
        expect(filtered.items.map((j) => j.name)).toEqual(['echo', 'Delta', 'bravo', 'Alpha']);
        expect(filtered.total).toBe(4);
      });

      it('enforces optimistic concurrency', async () => {
        const { jobs } = setup.ports();
        const job = makeJob();
        await jobs.insert(job);
        const edit = (newName: string) => ({ spec: { ...job, name: newName }, updatedAt: at(1) });
        const updated = await jobs.update(job.id, edit('renamed'), 1);
        expect(updated._unsafeUnwrap().version).toBe(2);
        expect((await jobs.update(job.id, edit('stale'), 1))._unsafeUnwrapErr().code).toBe(
          'version_conflict',
        );
        expect((await jobs.update(makeJob().id, edit('x'), 1))._unsafeUnwrapErr().code).toBe(
          'not_found',
        );
        expect((await jobs.get(job.id))?.name).toBe('renamed');
      });

      it('keeps concurrent scheduler and pause state when editing', async () => {
        const { jobs } = setup.ports();
        const job = makeJob();
        await jobs.insert(job);
        // The scheduler advances and the user pauses after the editor read version 1.
        await jobs.patchSchedule(
          job.id,
          { nextFireAt: at(60_000), fireCount: 1 },
          { pausedReason: 'Paused by user' },
        );

        const renamed = await jobs.update(
          job.id,
          { spec: { ...job, name: 'renamed' }, updatedAt: at(1) },
          1,
        );
        expect(renamed._unsafeUnwrap()).toMatchObject({
          name: 'renamed',
          pausedReason: 'Paused by user',
          schedule: { nextFireAt: at(60_000), fireCount: 1 },
        });

        const reschedule = { nextFireAt: at(5), basedOn: job.schedule };
        const stale = await jobs.update(
          job.id,
          { spec: { ...job, enabled: false }, updatedAt: at(2), reschedule },
          2,
        );
        expect(stale._unsafeUnwrapErr().code).toBe('version_conflict');
        expect((await jobs.get(job.id))?.schedule.nextFireAt).toEqual(at(60_000));
      });

      it('finds dependants through upstream edges and jobs by name', async () => {
        const { jobs } = setup.ports();
        const parent = makeJob({ name: 'extract' });
        const child = { ...makeJob({ name: 'load' }), upstreamJobIds: [parent.id] };
        await jobs.insert(parent);
        await jobs.insert(child);
        await jobs.insert(makeJob({ name: 'unrelated' }));
        expect((await jobs.findDependants(parent.id)).map((j) => j.id)).toEqual([child.id]);
        expect(await jobs.findDependants(child.id)).toEqual([]);

        const detached = await jobs.update(
          child.id,
          { spec: child, updatedAt: at(1), upstreamJobIds: [] },
          child.version,
        );
        expect(detached._unsafeUnwrap().upstreamJobIds).toEqual([]);
        expect(await jobs.findDependants(parent.id)).toEqual([]);
        expect((await jobs.findByName('load')).map((j) => j.id)).toEqual([child.id]);
        expect(await jobs.findByName('LOAD')).toEqual([]);
      });

      it('finds jobs by the connections and endpoints they use', async () => {
        const { jobs } = setup.ports();
        const charge = {
          ...makeJob({ name: 'charge' }),
          connectionRefs: [{ key: 'billing', endpoint: 'charge' }, { key: 'audit' }],
        };
        const refund = { ...makeJob({ name: 'refund' }), connectionRefs: [{ key: 'billing' }] };
        await jobs.insert(charge);
        await jobs.insert(refund);
        await jobs.insert(makeJob({ name: 'inline' }));
        const ids = async (key: string, endpoint?: string) =>
          (await jobs.findByConnection(key, endpoint)).map((j) => j.name).toSorted();
        expect(await ids('billing')).toEqual(['charge', 'refund']);
        expect(await ids('billing', 'charge')).toEqual(['charge']);
        expect(await ids('audit')).toEqual(['charge']);
        expect(await ids('nope')).toEqual([]);
        expect((await jobs.get(charge.id))?.connectionRefs).toEqual(charge.connectionRefs);

        const moved = await jobs.update(
          refund.id,
          { spec: refund, updatedAt: at(1), connectionRefs: [{ key: 'audit', endpoint: 'log' }] },
          refund.version,
        );
        expect(moved._unsafeUnwrap().connectionRefs).toEqual([{ key: 'audit', endpoint: 'log' }]);
        expect(await ids('billing')).toEqual(['charge']);
        expect(await ids('audit', 'log')).toEqual(['refund']);
        expect(await jobs.delete(charge.id)).toBe(true);
        expect(await ids('audit')).toEqual(['refund']);
      });

      it('finds and filters jobs by their own environment', async () => {
        const { jobs } = setup.ports();
        const staged = makeJob({ name: 'staged', environment: 'staging' });
        await jobs.insert(staged);
        await jobs.insert(makeJob({ name: 'prod', environment: 'prod' }));
        await jobs.insert(makeJob({ name: 'base' }));
        const names = async (environment: string) =>
          (await jobs.findByEnvironment(environment)).map((j) => j.name);
        expect(await names('staging')).toEqual(['staged']);
        expect(
          (await jobs.list({ limit: 10, environment: 'prod' })).items.map((j) => j.name),
        ).toEqual(['prod']);
        expect((await jobs.get(staged.id))?.environment).toBe('staging');

        await jobs.update(
          staged.id,
          { spec: { ...staged, environment: null }, updatedAt: at(1) },
          staged.version,
        );
        expect(await names('staging')).toEqual([]);
      });

      it('counts concurrent failures atomically and auto-pauses at the threshold', async () => {
        const { jobs } = setup.ports();
        const job = makeJob();
        await jobs.insert(job);
        await Promise.all([1, 2, 3].map(() => jobs.recordFailure(job.id, { pauseAfter: 2 })));
        const stored = await jobs.get(job.id);
        expect(stored?.schedule.consecutiveFailures).toBe(3);
        expect(stored?.pausedReason).toMatch(/^Auto-paused after [23] consecutive failures$/);

        const other = makeJob();
        await jobs.insert(other);
        await jobs.recordFailure(other.id, {});
        expect((await jobs.get(other.id))?.pausedReason).toBeNull();
      });
    });

    describe('ScheduleStore', () => {
      it('hands each due job to exactly one claimer and dedupes fired runs', async () => {
        const { jobs, schedule, runs } = setup.ports();
        const due = makeJob({}, T0);
        await jobs.insert(due);
        await jobs.insert(makeJob({}, at(60_000)));
        await jobs.insert(makeJob({ enabled: false }, T0));

        const [first, second] = await Promise.all([
          schedule.claimDue({ now: at(1), ownerId: 's1', leaseMs: 5_000, limit: 10 }),
          schedule.claimDue({ now: at(1), ownerId: 's2', leaseMs: 5_000, limit: 10 }),
        ]);
        expect([...first, ...second].map((j) => j.id)).toEqual([due.id]);

        const run = makePendingRun(due, { key: `sched:${due.id}:${T0.toISOString()}` });
        const inserted = await schedule.commitFire({
          jobId: due.id,
          jobVersion: due.version,
          ownerId: first.length ? 's1' : 's2',
          now: at(2),
          runs: [run],
          schedule: { nextFireAt: at(60_000), lastFiredAt: T0, fireCount: 1 },
        });
        expect(inserted._unsafeUnwrap()).toHaveLength(1);
        expect((await jobs.get(due.id))?.schedule.nextFireAt).toEqual(at(60_000));

        const duplicate = makePendingRun(due, { key: `sched:${due.id}:${T0.toISOString()}` });
        expect((await runs.insert(duplicate))._unsafeUnwrapErr().code).toBe('duplicate_run');
      });

      it('writes nothing for a scheduler that lost its claim', async () => {
        const { jobs, schedule, runs } = setup.ports();
        const job = makeJob({}, T0);
        await jobs.insert(job);
        const fire = (ownerId: string, now: Date, key: string) =>
          schedule.commitFire({
            jobId: job.id,
            jobVersion: job.version,
            ownerId,
            now,
            runs: [makePendingRun(job, { key })],
            schedule: { nextFireAt: at(60_000), lastFiredAt: T0, fireCount: 1 },
          });

        await schedule.claimDue({ now: at(1), ownerId: 'old', leaseMs: 1_000, limit: 1 });
        expect((await fire('old', at(2_000), 'expired'))._unsafeUnwrapErr().code).toBe(
          'stale_claim',
        );
        await schedule.claimDue({ now: at(2_000), ownerId: 'new', leaseMs: 1_000, limit: 1 });
        expect((await fire('old', at(2_001), 'taken-over')).isErr()).toBe(true);
        expect(await runs.countByStatus(job.id, ['pending'])).toBe(0);
        expect((await jobs.get(job.id))?.schedule.fireCount).toBe(0);

        expect((await fire('new', at(2_001), 'current'))._unsafeUnwrap()).toHaveLength(1);
        expect(await runs.countByStatus(job.id, ['pending'])).toBe(1);
      });
      it('writes nothing when the job was edited after the claim', async () => {
        const { jobs, schedule, runs } = setup.ports();
        const job = makeJob({}, T0);
        await jobs.insert(job);
        const [claimed] = await schedule.claimDue({
          now: at(1),
          ownerId: 's1',
          leaseMs: 5_000,
          limit: 1,
        });
        expect(claimed?.id).toBe(job.id);
        const reschedule = { nextFireAt: null, basedOn: job.schedule };
        const edited = await jobs.update(
          job.id,
          { spec: { ...job, enabled: false }, updatedAt: at(2), reschedule },
          job.version,
        );
        expect(edited.isOk()).toBe(true);

        const committed = await schedule.commitFire({
          jobId: job.id,
          jobVersion: job.version,
          ownerId: 's1',
          now: at(3),
          runs: [makePendingRun(job, { key: 'stale-plan' })],
          schedule: { nextFireAt: at(60_000), lastFiredAt: T0, fireCount: 1 },
        });
        expect(committed._unsafeUnwrapErr().code).toBe('stale_claim');
        expect(await runs.countByStatus(job.id, ['pending'])).toBe(0);
        const stored = await jobs.get(job.id);
        expect(stored?.enabled).toBe(false);
        expect(stored?.schedule.nextFireAt).toBeNull();
      });
    });

    describe('RunQueue + RunRepository', () => {
      it('rejects a transition from a snapshot taken before the lease was renewed', async () => {
        const ports = setup.ports();
        const running = await claimOne(ports);
        const until = at(3_000);
        await ports.queue.renewLease({
          runId: running.id,
          workerId: running.lease.workerId,
          until,
        });
        expect((await ports.runs.transition(running, succeed(running))).isErr()).toBe(true);
        const renewed = { ...running, lease: { ...running.lease, until } };
        expect((await ports.runs.transition(renewed, succeed(running))).isOk()).toBe(true);
      });

      it('claims each pending run once, renews, cancels and CAS-transitions', async () => {
        const { jobs, runs, queue } = setup.ports();
        const job = makeJob();
        await jobs.insert(job);
        const pending = makePendingRun(job);
        await runs.insert(pending);

        const claims = await Promise.all([
          queue.claimNext({ workerId: 'w1', now: at(5), leaseMs: 1_000 }),
          queue.claimNext({ workerId: 'w2', now: at(5), leaseMs: 1_000 }),
        ]);
        const running = claims.find((c) => c !== undefined);
        expect(claims.filter((c) => c !== undefined)).toHaveLength(1);
        if (!running) {
          throw new Error('expected a claim');
        }

        const until = at(3_000);
        expect(await queue.renewLease({ runId: running.id, workerId: 'other', until })).toEqual({
          renewed: false,
          cancelRequested: false,
        });
        expect(await queue.requestCancel(running.id)).toBe(true);
        expect(
          await queue.renewLease({ runId: running.id, workerId: running.lease.workerId, until }),
        ).toEqual({
          renewed: true,
          cancelRequested: true,
        });
        expect(await queue.findExpired({ now: at(2_000), limit: 10 })).toHaveLength(0);
        expect(await queue.findExpired({ now: at(4_000), limit: 10 })).toHaveLength(1);

        const renewed = { ...running, lease: { ...running.lease, until } };
        expect((await runs.transition(renewed, succeed(running))).isOk()).toBe(true);
        expect((await runs.get(running.id))?.status).toBe('succeeded');
        expect(await runs.countByStatus(job.id, ['succeeded'])).toBe(1);
      });

      it('prunes history per job', async () => {
        const { jobs, runs, queue } = setup.ports();
        const job = makeJob();
        await jobs.insert(job);
        for (let i = 0; i < 5; i++) {
          await runs.insert(makePendingRun(job, { scheduledAt: at(i) }));
          const r = await queue.claimNext({ workerId: 'w', now: at(100), leaseMs: 1_000 });
          if (!r) {
            throw new Error('claim');
          }
          await runs.transition(
            r,
            finishAttempt(r, {
              result: { outcome: 'success', durationMs: 1 },
              retry: RetryPolicy.parse({}),
              now: at(200),
            }),
          );
        }
        expect(await runs.prune(job.id, { succeeded: 2, failed: 0 })).toBe(3);
        expect(await runs.countByStatus(job.id, ['succeeded'])).toBe(2);
      });
    });

    describe('GroupRepository', () => {
      it('round-trips, enforces unique names and versions, and deletes', async () => {
        const { groups } = setup.ports();
        const ops = makeGroup('ops');
        expect((await groups.insert(ops))._unsafeUnwrap()).toEqual(ops);
        expect((await groups.insert(makeGroup('ops')))._unsafeUnwrapErr().code).toBe('conflict');
        await groups.insert(makeGroup('billing'));
        expect(await groups.get(ops.id)).toEqual(ops);
        expect((await groups.findByName('OPS'))?.id).toBe(ops.id);
        expect(await groups.findByName('nope')).toBeUndefined();
        expect((await groups.list({ limit: 10 })).total).toBe(2);
        expect((await groups.list({ limit: 10, search: 'BILL' })).items.map((g) => g.name)).toEqual(
          ['billing'],
        );

        const spec = GroupSpec.parse({ name: 'operations', rateLimit: { maxConcurrent: 2 } });
        const renamed = await groups.update(ops.id, { spec, updatedAt: at(1) }, 1);
        expect(renamed._unsafeUnwrap()).toMatchObject({ name: 'operations', version: 2 });
        expect(
          (await groups.update(ops.id, { spec, updatedAt: at(2) }, 1))._unsafeUnwrapErr().code,
        ).toBe('version_conflict');
        const taken = GroupSpec.parse({ name: 'billing' });
        expect(
          (await groups.update(ops.id, { spec: taken, updatedAt: at(3) }, 2))._unsafeUnwrapErr()
            .code,
        ).toBe('conflict');
        expect(
          (await groups.update(newGroupId(), { spec, updatedAt: at(4) }, 1))._unsafeUnwrapErr()
            .code,
        ).toBe('not_found');
        expect(await groups.delete(ops.id)).toBe(true);
        expect(await groups.get(ops.id)).toBeUndefined();
      });

      it('finds groups by the connections their notifications use', async () => {
        const { groups } = setup.ports();
        const ops = {
          ...makeGroup('ops'),
          connectionRefs: [{ key: 'hooks', endpoint: 'alerts' }, { key: 'mail' }],
        };
        await groups.insert(ops);
        await groups.insert(makeGroup('billing'));
        const ids = async (key: string, endpoint?: string) =>
          (await groups.findByConnection(key, endpoint)).map((g) => g.id);
        expect(await ids('hooks')).toEqual([ops.id]);
        expect(await ids('hooks', 'alerts')).toEqual([ops.id]);
        expect(await ids('hooks', 'other')).toEqual([]);
        expect(await ids('mail')).toEqual([ops.id]);

        const moved = await groups.update(
          ops.id,
          {
            spec: GroupSpec.parse({ name: 'ops' }),
            connectionRefs: [{ key: 'mail' }],
            updatedAt: at(1),
          },
          1,
        );
        expect(moved._unsafeUnwrap().connectionRefs).toEqual([{ key: 'mail' }]);
        expect(await ids('hooks')).toEqual([]);
        expect(await ids('mail')).toEqual([ops.id]);
        expect(await groups.delete(ops.id)).toBe(true);
        expect(await ids('mail')).toEqual([]);
      });

      it('finds groups by their environment', async () => {
        const { groups } = setup.ports();
        const ops = createGroup({
          id: newGroupId(),
          spec: GroupSpec.parse({ name: 'ops', environment: 'staging' }),
          now: T0,
        });
        await groups.insert(ops);
        await groups.insert(makeGroup('billing'));
        const ids = async (environment: string) =>
          (await groups.findByEnvironment(environment)).map((g) => g.id);
        expect(await ids('staging')).toEqual([ops.id]);
        await groups.update(
          ops.id,
          { spec: GroupSpec.parse({ name: 'ops' }), updatedAt: at(1) },
          1,
        );
        expect(await ids('staging')).toEqual([]);
      });
    });

    describe('ConnectionRepository', () => {
      it('round-trips, enforces unique keys and versions, filters and deletes', async () => {
        const { connections } = setup.ports();
        const billing = makeConnection('billing');
        expect((await connections.insert(billing))._unsafeUnwrap()).toEqual(billing);
        expect((await connections.insert(makeConnection('billing')))._unsafeUnwrapErr().code).toBe(
          'conflict',
        );
        await connections.insert(makeConnection('events', 'aws'));
        await connections.insert(makeConnection('audit'));
        expect(await connections.get('billing')).toEqual(billing);
        expect(await connections.get('nope')).toBeUndefined();
        expect(
          (await connections.getMany(['events', 'billing', 'nope'])).map((c) => c.key).toSorted(),
        ).toEqual(['billing', 'events']);
        expect(await connections.getMany([])).toEqual([]);

        const page = await connections.list({ limit: 2 });
        expect(page.items.map((c) => c.key)).toEqual(['audit', 'billing']);
        expect(page.total).toBe(3);
        const rest = await connections.list({ limit: 2, cursor: page.nextCursor ?? undefined });
        expect(rest.items.map((c) => c.key)).toEqual(['events']);
        expect(rest.nextCursor).toBeNull();
        expect(
          (await connections.list({ limit: 10, type: 'aws' })).items.map((c) => c.key),
        ).toEqual(['events']);
        expect(
          (await connections.list({ limit: 10, search: 'BILL' })).items.map((c) => c.key),
        ).toEqual(['billing']);

        const spec = ConnectionSpec.parse({ ...billing, name: 'Billing API', endpoints: [] });
        const renamed = await connections.update('billing', { spec, updatedAt: at(1) }, 1);
        expect(renamed._unsafeUnwrap()).toMatchObject({
          key: 'billing',
          name: 'Billing API',
          endpoints: [],
          version: 2,
          createdAt: T0,
          updatedAt: at(1),
        });
        expect(
          (await connections.update('billing', { spec, updatedAt: at(2) }, 1))._unsafeUnwrapErr()
            .code,
        ).toBe('version_conflict');
        expect(
          (await connections.update('nope', { spec, updatedAt: at(2) }, 1))._unsafeUnwrapErr().code,
        ).toBe('not_found');
        expect(await connections.delete('billing')).toBe(true);
        expect(await connections.delete('billing')).toBe(false);
        expect(await connections.get('billing')).toBeUndefined();
      });

      it('finds connections by the environments they overlay', async () => {
        const { connections } = setup.ports();
        const billing = makeConnection('billing');
        const staged = ConnectionSpec.parse({
          ...billing,
          overlays: [
            { environment: 'staging', config: { baseUrl: 'https://staging.test' } },
            { environment: 'prod', endpoints: [{ key: 'ping', config: { url: '/live' } }] },
          ],
        });
        await connections.insert({ ...billing, ...staged });
        await connections.insert(makeConnection('audit'));
        const keys = async (environment: string) =>
          (await connections.findByEnvironment(environment)).map((c) => c.key);
        expect(await keys('staging')).toEqual(['billing']);
        expect(await keys('prod')).toEqual(['billing']);
        expect((await connections.get('billing'))?.overlays).toEqual(staged.overlays);

        const prodOnly = ConnectionSpec.parse({ ...staged, overlays: staged.overlays.slice(1) });
        await connections.update('billing', { spec: prodOnly, updatedAt: at(1) }, 1);
        expect(await keys('staging')).toEqual([]);
        expect(await keys('prod')).toEqual(['billing']);
        expect(await connections.delete('billing')).toBe(true);
        expect(await keys('prod')).toEqual([]);
      });
    });

    describe('EnvironmentRepository', () => {
      it('round-trips, enforces unique keys and versions, lists and deletes', async () => {
        const { environments } = setup.ports();
        const staging = makeEnvironment('staging', 'Staging');
        expect((await environments.insert(staging))._unsafeUnwrap()).toEqual(staging);
        expect(
          (await environments.insert(makeEnvironment('staging')))._unsafeUnwrapErr().code,
        ).toBe('conflict');
        await environments.insert(makeEnvironment('prod', 'Production'));
        expect(await environments.get('staging')).toEqual(staging);
        expect(await environments.get('nope')).toBeUndefined();

        const page = await environments.list({ limit: 1 });
        expect(page.items.map((e) => e.key)).toEqual(['prod']);
        expect(page.total).toBe(2);
        const rest = await environments.list({ limit: 1, cursor: page.nextCursor ?? undefined });
        expect(rest.items.map((e) => e.key)).toEqual(['staging']);
        expect(rest.nextCursor).toBeNull();
        expect(
          (await environments.list({ limit: 10, search: 'PROD' })).items.map((e) => e.key),
        ).toEqual(['prod']);

        const spec = EnvironmentSpec.parse({ key: 'staging', name: 'Pre-production' });
        const renamed = await environments.update('staging', { spec, updatedAt: at(1) }, 1);
        expect(renamed._unsafeUnwrap()).toMatchObject({
          key: 'staging',
          name: 'Pre-production',
          version: 2,
          createdAt: T0,
          updatedAt: at(1),
        });
        expect(
          (await environments.update('staging', { spec, updatedAt: at(2) }, 1))._unsafeUnwrapErr()
            .code,
        ).toBe('version_conflict');
        expect(
          (await environments.update('nope', { spec, updatedAt: at(2) }, 1))._unsafeUnwrapErr()
            .code,
        ).toBe('not_found');
        expect(await environments.delete('staging')).toBe(true);
        expect(await environments.delete('staging')).toBe(false);
        expect(await environments.get('staging')).toBeUndefined();
      });
    });

    describe('AuthSettingsStore', () => {
      it('creates once and updates with CAS', async () => {
        const { authSettings } = setup.ports();
        expect(await authSettings.get()).toBeUndefined();
        const settings = makeAuthSettings({ anonymous: { scopes: ['read'] } });
        expect((await authSettings.create(settings))._unsafeUnwrap()).toEqual(settings);
        expect((await authSettings.create(makeAuthSettings()))._unsafeUnwrapErr().code).toBe(
          'conflict',
        );
        expect(await authSettings.get()).toEqual(settings);

        const next = { ...settings, oidc: { ...settings.oidc, enabled: true }, version: 2 };
        expect((await authSettings.update(next, 1))._unsafeUnwrap()).toEqual(next);
        expect(
          (await authSettings.update({ ...next, version: 2 }, 1))._unsafeUnwrapErr().code,
        ).toBe('version_conflict');
        expect(await authSettings.get()).toEqual(next);
      });
    });

    describe('UserRepository', () => {
      it('enforces unique usernames, versions updates and counts active admins', async () => {
        const { users } = setup.ports();
        const admin = makeUser({ username: 'Admin' });
        expect((await users.insert(admin))._unsafeUnwrap()).toEqual(admin);
        expect((await users.insert(makeUser({ username: 'admin' })))._unsafeUnwrapErr().code).toBe(
          'conflict',
        );
        const viewer = makeUser({ username: 'viewer', scopes: ['read'] });
        await users.insert(viewer);
        await users.insert(makeUser({ username: 'old-admin', disabled: true }));

        expect(await users.get(admin.id)).toEqual(admin);
        expect((await users.findByUsername('ADMIN'))?.id).toBe(admin.id);
        expect(await users.findByUsername('nobody')).toBeUndefined();
        expect(await users.countActiveAdmins()).toBe(1);
        expect((await users.list({ limit: 10 })).total).toBe(3);
        expect((await users.list({ limit: 10, search: 'VIEW' })).items.map((u) => u.id)).toEqual([
          viewer.id,
        ]);

        const promoted = { ...viewer, scopes: ['admin' as const], version: 2, updatedAt: at(1) };
        expect((await users.update(promoted, 1))._unsafeUnwrap()).toEqual(promoted);
        expect(await users.countActiveAdmins()).toBe(2);
        expect((await users.update({ ...promoted, version: 2 }, 1))._unsafeUnwrapErr().code).toBe(
          'version_conflict',
        );
        expect(
          (await users.update(makeUser({ username: 'ghost' }), 1))._unsafeUnwrapErr().code,
        ).toBe('not_found');
        expect(await users.delete(viewer.id)).toBe(true);
        expect(await users.delete(viewer.id)).toBe(false);
        expect(await users.countActiveAdmins()).toBe(1);
      });
    });

    describe('ApiKeyRepository', () => {
      it('finds keys by hash, touches and revokes them', async () => {
        const { apiKeys } = setup.ports();
        const key = makeApiKey({ hash: 'b'.repeat(64) });
        expect((await apiKeys.insert(key))._unsafeUnwrap()).toEqual(key);
        expect(
          (await apiKeys.insert(makeApiKey({ hash: 'b'.repeat(64) })))._unsafeUnwrapErr().code,
        ).toBe('conflict');
        await apiKeys.insert(makeApiKey({ name: 'other', hash: 'c'.repeat(64) }));
        expect(await apiKeys.findByHash('b'.repeat(64))).toEqual(key);
        expect(await apiKeys.findByHash('d'.repeat(64))).toBeUndefined();

        await apiKeys.touch(key.id, at(5));
        expect((await apiKeys.findByHash(key.hash))?.lastUsedAt).toEqual(at(5));
        expect(await apiKeys.revoke(key.id, at(6))).toBe(true);
        expect((await apiKeys.findByHash(key.hash))?.revokedAt).toEqual(at(6));
        expect((await apiKeys.list()).map((k) => k.name).toSorted()).toEqual(['ci', 'other']);
      });
    });

    describe('RateLimiter', () => {
      it('never hands out more concurrency slots than the limit under contention', async () => {
        const { rateLimiter } = setup.ports();
        const limit = { maxConcurrent: 2 };
        const attempts = await Promise.all(
          Array.from({ length: 8 }, () => rateLimiter.tryAcquire('g:1', limit, at(0))),
        );
        expect(attempts.filter((a) => a.ok)).toHaveLength(2);
        const blocked = attempts.find((a) => !a.ok);
        expect(blocked && !blocked.ok && blocked.retryAt > at(0)).toBe(true);
        await rateLimiter.release('g:1', at(1));
        expect(await rateLimiter.tryAcquire('g:1', limit, at(2))).toEqual({
          ok: true,
          holdsSlot: true,
        });
        expect((await rateLimiter.tryAcquire('g:1', limit, at(3))).ok).toBe(false);
      });

      it('refills tokens at the configured rate', async () => {
        const { rateLimiter } = setup.ports();
        const limit = { perSecond: 2 };
        expect(await rateLimiter.tryAcquire('g:2', limit, at(0))).toEqual({
          ok: true,
          holdsSlot: false,
        });
        expect((await rateLimiter.tryAcquire('g:2', limit, at(0))).ok).toBe(true);
        const third = await rateLimiter.tryAcquire('g:2', limit, at(0));
        expect(third).toEqual({ ok: false, retryAt: at(500) });
        expect((await rateLimiter.tryAcquire('g:2', limit, at(500))).ok).toBe(true);
      });

      it('reconciles a leaked counter only when idle', async () => {
        const { rateLimiter } = setup.ports();
        const limit = { maxConcurrent: 1 };
        await rateLimiter.tryAcquire('g:3', limit, at(0));
        expect(await rateLimiter.reconcile('g:3', { running: 0, idleSince: at(0) })).toBe(false);
        expect(await rateLimiter.reconcile('g:3', { running: 0, idleSince: at(1) })).toBe(true);
        expect((await rateLimiter.tryAcquire('g:3', limit, at(2))).ok).toBe(true);
        expect(await rateLimiter.listHeld()).toEqual([{ key: 'g:3', running: 1 }]);
      });

      it('lets denied attempts age a leaked slot toward reconciliation', async () => {
        const { rateLimiter } = setup.ports();
        const limit = { maxConcurrent: 1 };
        await rateLimiter.tryAcquire('g:4', limit, at(0));
        for (const t of [100, 200, 300]) {
          expect((await rateLimiter.tryAcquire('g:4', limit, at(t))).ok).toBe(false);
        }
        expect(await rateLimiter.reconcile('g:4', { running: 0, idleSince: at(50) })).toBe(true);
        expect((await rateLimiter.tryAcquire('g:4', limit, at(400))).ok).toBe(true);
      });

      it('records slot holders on running runs without breaking their CAS', async () => {
        const ports = setup.ports();
        const running = await claimOne(ports);
        expect(running.rateLimitKey).toBeNull();
        expect(await ports.runs.markSlotHeld(running, 'group:x')).toBe(true);
        expect(await ports.runs.countHoldingSlot('group:x')).toBe(1);
        expect((await ports.runs.transition(running, succeed(running))).isOk()).toBe(true);
        expect(await ports.runs.countHoldingSlot('group:x')).toBe(0);
      });
    });

    describe('DecisionLog', () => {
      it('returns the newest decisions for a job up to a point in time', async () => {
        const { decisions } = setup.ports();
        const job = makeJob();
        const decision = (ms: number, kind: 'overlap_skipped' | 'paused') => ({
          jobId: job.id,
          runId: null,
          at: at(ms),
          fireTime: at(ms - 1),
          decision: kind,
          detail: `d${ms}`,
        });
        await decisions.record(decision(1_000, 'overlap_skipped'));
        await decisions.record(decision(2_000, 'paused'));
        await decisions.record(decision(3_000, 'overlap_skipped'));
        await decisions.record({ ...decision(2_500, 'paused'), jobId: makeJob().id });

        const recent = await decisions.listRecent(job.id, { before: at(2_000), limit: 10 });
        expect(recent.map((d) => d.detail)).toEqual(['d2000', 'd1000']);
        expect(recent[0]).toEqual(decision(2_000, 'paused'));
        expect(await decisions.listRecent(job.id, { before: at(9_000), limit: 1 })).toHaveLength(1);
      });
    });

    describe('Failed runs inbox', () => {
      it('acknowledges only unacknowledged failures and filters them', async () => {
        const { jobs, runs, queue } = setup.ports();
        const job = makeJob();
        await jobs.insert(job);
        const finish = async (outcome: 'success' | 'failure', scheduledAt: Date) => {
          await runs.insert(makePendingRun(job, { scheduledAt }));
          const claimed = await queue.claimNext({ workerId: 'w', now: at(100), leaseMs: 1_000 });
          if (!claimed) {
            throw new Error('expected a claim');
          }
          const next = finishAttempt(claimed, {
            result:
              outcome === 'success'
                ? { outcome, durationMs: 1 }
                : { outcome, durationMs: 1, error: { code: 'x', message: 'x', retryable: false } },
            retry: RetryPolicy.parse({ maxAttempts: 1 }),
            now: at(200),
          });

          return (await runs.transition(claimed, next))._unsafeUnwrap();
        };
        const failed = await finish('failure', at(1));
        const failedToo = await finish('failure', at(2));
        const succeeded = await finish('success', at(3));
        const inbox = { limit: 10, status: ['failed', 'timed_out'] as const, acknowledged: false };
        expect((await runs.list(inbox)).total).toBe(2);

        expect(await runs.acknowledge([failed.id, succeeded.id], at(300))).toBe(1);
        expect(await runs.acknowledge([failed.id], at(400))).toBe(0);
        expect((await runs.list(inbox)).items.map((r) => r.id)).toEqual([failedToo.id]);
        expect((await runs.get(failed.id))?.acknowledgedAt).toEqual(at(300));
        expect((await runs.get(succeeded.id))?.acknowledgedAt).toBeNull();
      });
    });

    describe('SLA tracking', () => {
      it('finds runs past their deadline and fences SLA updates', async () => {
        const { jobs, runs, queue } = setup.ports();
        const job = makeJob({ policy: { sla: { maxStartDelayMs: 1_000, maxDurationMs: 5_000 } } });
        await jobs.insert(job);
        const pending = makePendingRun(job);
        expect(pending.slaDeadline).toEqual(at(1_000));
        await runs.insert(pending);
        await runs.insert(makePendingRun(makeJob(), { scheduledAt: at(1) }));

        expect(await runs.findLateCandidates({ now: at(999), limit: 10 })).toHaveLength(0);
        const [candidate] = await runs.findLateCandidates({ now: at(1_000), limit: 10 });
        expect(candidate?.id).toBe(pending.id);
        if (!candidate) {
          throw new Error('expected a candidate');
        }
        const late = { late: true, lateReasons: ['slow start'], slaDeadline: null };
        expect(await runs.updateSla(candidate, late)).toBe(true);
        expect(await runs.updateSla(candidate, late)).toBe(false);
        expect(await runs.findLateCandidates({ now: at(99_999), limit: 10 })).toHaveLength(0);

        const claimed = await queue.claimNext({ workerId: 'w', now: at(2_000), leaseMs: 1_000 });
        expect(claimed).toMatchObject({ late: true, lateReasons: ['slow start'] });
        if (!claimed) {
          throw new Error('expected a claim');
        }
        const saved = await runs.transition(claimed, {
          ...succeed(claimed),
          late: false,
          lateReasons: [],
        });
        expect(saved._unsafeUnwrap()).toMatchObject({
          status: 'succeeded',
          late: true,
          lateReasons: ['slow start'],
        });
      });

      it('arms the duration deadline when a run is claimed', async () => {
        const { jobs, runs, queue } = setup.ports();
        const job = makeJob({ policy: { sla: { maxDurationMs: 5_000 } } });
        await jobs.insert(job);
        await runs.insert(makePendingRun(job));
        const claimed = await queue.claimNext({ workerId: 'w', now: at(100), leaseMs: 60_000 });
        expect(claimed?.slaDeadline).toEqual(at(5_100));
        expect(await runs.findLateCandidates({ now: at(5_099), limit: 10 })).toHaveLength(0);
        expect(await runs.findLateCandidates({ now: at(5_100), limit: 10 })).toHaveLength(1);
        expect((await runs.list({ limit: 10, late: false })).total).toBe(1);
      });

      it('finds jobs past their success deadline and fences breach updates', async () => {
        const { jobs } = setup.ports();
        const job = makeJob({ policy: { sla: { maxSinceLastSuccessMs: 10_000 } } });
        await jobs.insert(job);
        await jobs.insert(makeJob());
        expect(job.schedule.successDeadline).toEqual(at(10_000));
        expect(await jobs.findStaleJobs({ now: at(9_999), limit: 10 })).toHaveLength(0);
        const [stale] = await jobs.findStaleJobs({ now: at(10_000), limit: 10 });
        if (!stale) {
          throw new Error('expected a stale job');
        }
        const breach = { slaBreachedAt: at(10_000), successDeadline: null };
        expect(await jobs.updateSlaState(stale, breach)).toBe(true);
        expect(await jobs.updateSlaState(stale, breach)).toBe(false);
        expect(await jobs.findStaleJobs({ now: at(99_999), limit: 10 })).toHaveLength(0);
        expect((await jobs.list({ limit: 10, slaBreached: true })).items.map((j) => j.id)).toEqual([
          job.id,
        ]);

        await jobs.patchSchedule(job.id, { successDeadline: at(50_000) }, { slaBreachedAt: null });
        expect((await jobs.get(job.id))?.slaBreachedAt).toBeNull();
      });
    });

    describe('NotificationOutbox', () => {
      it('dedupes by key and hands each entry to one dispatcher', async () => {
        const { outbox } = setup.ports();
        const job = makeJob();
        const first = makeDelivery(job, { subject: 'run-1' });
        const again = makeDelivery(job, { subject: 'run-1' });
        expect(await outbox.enqueue([first])).toBe(1);
        expect(await outbox.enqueue([again, makeDelivery(job, { subject: 'run-2' })])).toBe(1);

        const claims = await Promise.all(
          ['d1', 'd2', 'd3'].map((workerId) =>
            outbox.claimNext({ workerId, now: at(1), leaseMs: 1_000 }),
          ),
        );
        const claimed = claims.filter((c) => c !== undefined);
        expect(claimed).toHaveLength(2);
        expect(new Set(claimed.map((c) => c.key)).size).toBe(2);
        expect(claimed.every((c) => c.status === 'sending' && c.attempts === 1)).toBe(true);
        expect(
          await outbox.claimNext({ workerId: 'd4', now: at(2), leaseMs: 1_000 }),
        ).toBeUndefined();
      });

      it('reclaims an entry whose lease expired and fences the old dispatcher', async () => {
        const { outbox } = setup.ports();
        const delivery = makeDelivery(makeJob());
        await outbox.enqueue([delivery]);
        const stale = await outbox.claimNext({ workerId: 'old', now: at(1), leaseMs: 1_000 });
        expect(
          await outbox.claimNext({ workerId: 'new', now: at(500), leaseMs: 1_000 }),
        ).toBeUndefined();
        const fresh = await outbox.claimNext({ workerId: 'new', now: at(2_000), leaseMs: 1_000 });
        if (!stale || !fresh) {
          throw new Error('expected claims');
        }
        expect(fresh.attempts).toBe(2);
        expect(await outbox.complete(stale, at(2_001))).toBe(false);
        expect(await outbox.complete(fresh, at(2_001))).toBe(true);
        expect(
          await outbox.claimNext({ workerId: 'x', now: at(9_000), leaseMs: 1_000 }),
        ).toBeUndefined();
      });

      it('retries a failed entry later and gives up when no retry is scheduled', async () => {
        const { outbox } = setup.ports();
        const delivery = makeDelivery(makeJob());
        await outbox.enqueue([delivery]);
        const first = await outbox.claimNext({ workerId: 'd', now: at(1), leaseMs: 1_000 });
        if (!first) {
          throw new Error('expected a claim');
        }
        expect(await outbox.fail(first, { error: 'HTTP 500', retryAt: at(100), now: at(2) })).toBe(
          true,
        );
        expect(
          await outbox.claimNext({ workerId: 'd', now: at(50), leaseMs: 1_000 }),
        ).toBeUndefined();
        const second = await outbox.claimNext({ workerId: 'd', now: at(100), leaseMs: 1_000 });
        if (!second) {
          throw new Error('expected a retry claim');
        }
        expect(second.lastError).toBe('HTTP 500');
        await outbox.fail(second, { error: 'HTTP 500', retryAt: null, now: at(101) });
        expect(
          await outbox.claimNext({ workerId: 'd', now: at(9_999), leaseMs: 1_000 }),
        ).toBeUndefined();
      });

      it('lists deliveries for a run', async () => {
        const { outbox } = setup.ports();
        const job = makeJob();
        const run = makePendingRun(job);
        const delivery = { ...makeDelivery(job, { subject: run.id }), runId: run.id };
        await outbox.enqueue([delivery]);
        const claimed = await outbox.claimNext({ workerId: 'd', now: at(1), leaseMs: 1_000 });
        if (!claimed) {
          throw new Error('expected a claim');
        }
        await outbox.complete(claimed, at(3));
        const listed = await outbox.listByRun(run.id);
        expect(listed).toHaveLength(1);
        expect(listed[0]).toMatchObject({ status: 'delivered', deliveredAt: at(3), lease: null });
      });

      it('lists open deliveries that notify over a connection', async () => {
        const { outbox } = setup.ports();
        const job = makeJob();
        const over = (key: string): NotificationDelivery => {
          const delivery = makeDelivery(job);

          return { ...delivery, notifier: { ...delivery.notifier, connection: { key } } };
        };
        const sending = over('hooks');
        const done = over('hooks');
        const later = { availableAt: at(5_000) };
        const pending = { ...over('hooks'), ...later };
        await outbox.enqueue([
          sending,
          done,
          pending,
          { ...over('other'), ...later },
          { ...makeDelivery(job), ...later },
        ]);
        const first = await outbox.claimNext({ workerId: 'd', now: at(1), leaseMs: 1_000 });
        const second = await outbox.claimNext({ workerId: 'd', now: at(1), leaseMs: 1_000 });
        const completed = [first, second].find((claimed) => claimed?.id === done.id);
        if (!completed) {
          throw new Error('expected a claim');
        }
        await outbox.complete(completed, at(2));

        const open = await outbox.listOpenByConnection('hooks');
        expect(open.map((delivery) => [delivery.id, delivery.status])).toEqual(
          expect.arrayContaining([
            [sending.id, 'sending'],
            [pending.id, 'pending'],
          ]),
        );
        expect(open).toHaveLength(2);
        expect(await outbox.listOpenByConnection('missing')).toEqual([]);
      });
    });

    describe('RunAnalytics', () => {
      it('summarises, buckets and ranks errors', async () => {
        const { analytics } = setup.ports();
        const job = makeJob();
        const base = {
          jobId: job.id,
          targetType: 'http',
          attempts: 1,
          late: false,
          statusCode: 200,
        };
        for (let i = 0; i < 8; i++) {
          await analytics.record({
            ...base,
            ts: at(i * 60_000),
            status: 'succeeded',
            durationMs: 100 + i,
            errorCode: null,
          });
        }
        await analytics.record({
          ...base,
          ts: at(30_000),
          status: 'failed',
          durationMs: 900,
          errorCode: 'http_assertion',
        });
        await analytics.record({
          ...base,
          late: true,
          ts: at(90_000),
          status: 'failed',
          durationMs: 800,
          errorCode: 'http_assertion',
        });

        const range = { from: T0, to: at(3_600_000) };
        const summary = await analytics.summary(range);
        expect(summary.total).toBe(10);
        expect(summary.late).toBe(1);
        expect(summary.successRate).toBeCloseTo(0.8);
        expect(summary.p95Ms).toBeGreaterThan(100);

        const series = await analytics.timeseries({ ...range, bucket: 'minute' });
        expect(series[0]?.byStatus).toEqual({ succeeded: 1, failed: 1 });
        expect(series.reduce((n, p) => n + (p.byStatus.succeeded ?? 0), 0)).toBe(8);

        expect(await analytics.topErrors({ ...range, limit: 5 })).toEqual([
          { errorCode: 'http_assertion', jobId: job.id, count: 2 },
        ]);
      });
    });
  });
}
