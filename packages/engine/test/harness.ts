import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';

import {
  type Clock,
  type Job,
  type Persistence,
  ProviderRegistry,
  mapSecretResolver,
  silentLogger,
} from '@cloud-trigger/core';
import { builtinProviders } from '@cloud-trigger/providers-builtin';
import { afterAll, beforeAll, beforeEach } from 'vitest';

import {
  AnalyticsListener,
  ChainListener,
  JobService,
  NotificationDispatcher,
  type NotificationDispatcherOptions,
  NotificationEnqueuer,
  NotificationListener,
  type RunLifecycleListener,
  Scheduler,
  Worker,
  type WorkerDeps,
  type WorkerOptions,
  WorkflowAdvancer,
  WorkflowMonitor,
  WorkflowRuntime,
  WorkflowService,
} from '../src/index.js';
import { type TestDatabase, startTestDatabase } from './databases.js';

export interface ReceivedRequest {
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

type Handler = (req: ReceivedRequest) => { status: number; body?: string; delayMs?: number };

export interface Harness {
  readonly db: Persistence;
  readonly clear: (tables: readonly string[]) => Promise<void>;
  readonly base: () => string;
  readonly requests: ReceivedRequest[];
  readonly maxInFlight: () => number;
  readonly route: (prefix: string, handler: Handler) => void;
  readonly clock: Clock;
  readonly now: () => Date;
  readonly setNow: (at: Date) => void;
  readonly advance: (ms: number) => void;
  readonly registry: ProviderRegistry;
  readonly enqueuer: () => NotificationEnqueuer;
  readonly listeners: () => RunLifecycleListener[];
  readonly service: () => JobService;
  readonly workflowRuntime: () => WorkflowRuntime;
  readonly workflows: () => WorkflowService;
  readonly workflowMonitor: () => WorkflowMonitor;
  readonly scheduler: (ownerId?: string) => Scheduler;
  readonly worker: (opts?: Partial<WorkerOptions>, deps?: Partial<WorkerDeps>) => Worker;
  readonly dispatcher: (opts?: Partial<NotificationDispatcherOptions>) => NotificationDispatcher;
  readonly createJob: (path: string, extra?: Record<string, unknown>) => Promise<Job>;
  readonly settle: (worker: Worker) => Promise<void>;
  readonly drainOutbox: () => Promise<void>;
}

export function useHarness(dbName: string): Harness {
  let database: TestDatabase | undefined;
  let server: Server;
  let base = '';
  let current = new Date('2026-03-01T00:00:00.000Z');
  const requests: ReceivedRequest[] = [];
  const flight = { now: 0, max: 0 };
  const routes = new Map<string, Handler>();
  const registry = new ProviderRegistry().use(builtinProviders);
  const secrets = mapSecretResolver({});
  const clock: Clock = { now: () => new Date(current) };

  beforeAll(async () => {
    database = await startTestDatabase(dbName);
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      flight.now++;
      flight.max = Math.max(flight.max, flight.now);
      res.on('finish', () => {
        flight.now--;
      });
      req.on('end', () => {
        const received = { path: req.url ?? '/', headers: req.headers, body };
        requests.push(received);
        const handler = [...routes.entries()].find(([prefix]) =>
          received.path.startsWith(prefix),
        )?.[1];
        const reply = handler?.(received) ?? { status: 200, body: '{"ok":true}' };
        setTimeout(() => res.writeHead(reply.status).end(reply.body ?? ''), reply.delayMs ?? 0);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('tcp');
    }
    base = `http://127.0.0.1:${address.port}`;
  }, 120_000);

  afterAll(async () => {
    await database?.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    requests.length = 0;
    flight.max = 0;
    routes.clear();
    routes.set('/fail', () => ({ status: 503 }));
    routes.set('/slow', () => ({ status: 200, delayMs: 1_500 }));
    current = new Date('2026-03-01T00:00:00.000Z');
    await started().clear();
  });

  const started = (): TestDatabase => {
    if (!database) {
      throw new Error('harness not started');
    }

    return database;
  };
  const persistence = (): Persistence => started().persistence;
  const enqueuer = () =>
    new NotificationEnqueuer({ outbox: persistence().outbox, groups: persistence().groups, clock });
  const workflowRuntime = () =>
    new WorkflowRuntime({ ...persistence(), clock, logger: silentLogger });
  const listeners = (): RunLifecycleListener[] => [
    new AnalyticsListener(persistence().analytics),
    new NotificationListener(enqueuer()),
    new ChainListener({ ...persistence(), registry, clock, logger: silentLogger }),
    new WorkflowAdvancer(workflowRuntime()),
  ];
  const dispatcherFor = (opts: Partial<NotificationDispatcherOptions> = {}) =>
    new NotificationDispatcher(
      { outbox: persistence().outbox, registry, secrets, clock, logger: silentLogger },
      {
        workerId: 'd1',
        pollIntervalMs: 20,
        timeoutMs: 2_000,
        leaseMs: 10_000,
        retry: { maxAttempts: 5, backoff: 'exponential', delayMs: 1_000, maxDelayMs: 60_000 },
        ...opts,
      },
    );
  const service = () =>
    new JobService({
      ...persistence(),
      registry,
      clock,
      logger: silentLogger,
      listeners: listeners(),
    });

  return {
    get db() {
      return persistence();
    },
    clear: (tables) => started().clear(tables),
    base: () => base,
    requests,
    maxInFlight: () => flight.max,
    route: (prefix, handler) => routes.set(prefix, handler),
    clock,
    now: () => new Date(current),
    setNow: (at) => {
      current = new Date(at);
    },
    advance: (ms) => {
      current = new Date(current.getTime() + ms);
    },
    registry,
    enqueuer,
    listeners,
    service,
    workflowRuntime,
    workflows: () =>
      new WorkflowService({
        ...persistence(),
        registry,
        clock,
        jobService: service(),
        runtime: workflowRuntime(),
      }),
    workflowMonitor: () =>
      new WorkflowMonitor(
        { ...persistence(), registry, clock, logger: silentLogger, runtime: workflowRuntime() },
        { intervalMs: 1_000, batchSize: 50 },
      ),
    scheduler: (ownerId = 's1') =>
      new Scheduler(
        { ...persistence(), registry, clock, logger: silentLogger },
        { ownerId, intervalMs: 1_000, claimLeaseMs: 30_000, batchSize: 50 },
      ),
    worker: (opts = {}, deps = {}) =>
      new Worker(
        {
          ...persistence(),
          registry,
          secrets,
          clock,
          logger: silentLogger,
          listeners: listeners(),
          ...deps,
        },
        {
          workerId: 'w1',
          concurrency: 4,
          pollIntervalMs: 20,
          leaseMs: 30_000,
          bufferedRequeueDelayMs: 1_000,
          ...opts,
        },
      ),
    dispatcher: (opts = {}) => dispatcherFor(opts),
    createJob: async (path, extra = {}) =>
      (
        await service().create({
          name: `job ${path}`,
          trigger: { type: 'interval', config: { every: 1, unit: 'minutes' } },
          target: { type: 'http', config: { method: 'GET', url: `${base}${path}` } },
          ...extra,
        })
      )._unsafeUnwrap(),
    settle: async (worker) => {
      await worker.tick();
      await worker.stop();
    },
    drainOutbox: async () => {
      const dispatcher = dispatcherFor();
      let more = true;
      while (more) {
        more = await dispatcher.tick();
      }
    },
  };
}
