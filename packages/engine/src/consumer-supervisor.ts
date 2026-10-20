import { setTimeout as sleep } from 'node:timers/promises';

import {
  type BoundEventSource,
  type Clock,
  type ConnectionCatalog,
  type ConnectionRepository,
  type EventSourceLeases,
  type GroupRepository,
  type Job,
  type JobRepository,
  type Logger,
  type ProviderRegistry,
  type SecretResolver,
  type SourceMessage,
  inEnvironment,
  isSchedulable,
} from '@cloud-trigger/core';

import { bindTrigger, loadConnections } from './config-validation.js';
import type { EventIngestor } from './event-ingestor.js';
import { PollingLoop } from './loop.js';
import { PolicyResolver } from './policies.js';

export interface ConsumerSupervisorDeps {
  readonly jobs: JobRepository;
  readonly eventSources: EventSourceLeases;
  readonly registry: ProviderRegistry;
  readonly connections?: ConnectionRepository | undefined;
  readonly groups?: GroupRepository | undefined;
  readonly secrets: SecretResolver;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly ingestor: EventIngestor;
}

export interface ConsumerSupervisorOptions {
  readonly ownerId: string;
  readonly intervalMs: number;
  readonly leaseMs: number;
  readonly restartDelayMs: number;
  readonly maxRestartDelayMs?: number;
}

interface Subscription {
  readonly fingerprint: string;
  readonly exclusive: boolean;
  readonly controller: AbortController;
  readonly done: Promise<void>;
}

export const eventSourceLeaseKey = (jobId: string) => `source:${jobId}`;

const subscriptionFingerprint = (
  job: Job,
  catalog: ConnectionCatalog,
  environment: string | null,
): string => {
  const key = job.trigger.connection?.key;
  const connection = key === undefined ? undefined : catalog.get(key);

  return `${job.version}:${connection?.version ?? 0}:${environment ?? ''}`;
};

export class ConsumerSupervisor {
  readonly #loop: PollingLoop;
  readonly #subscriptions = new Map<string, Subscription>();
  readonly #policies: PolicyResolver;

  constructor(
    private readonly deps: ConsumerSupervisorDeps,
    private readonly options: ConsumerSupervisorOptions,
  ) {
    this.#policies = new PolicyResolver(deps.groups, deps.clock);
    this.#loop = new PollingLoop(
      'consumer-supervisor',
      options.intervalMs,
      async () => {
        await this.tick();

        return false;
      },
      deps.logger,
    );
  }

  get activeSubscriptions(): readonly string[] {
    return [...this.#subscriptions.keys()];
  }

  start(): void {
    this.#loop.start();
  }

  async stop(): Promise<void> {
    await this.#loop.stop();
    await Promise.all([...this.#subscriptions.keys()].map((jobId) => this.#unsubscribe(jobId)));
  }

  async tick(): Promise<void> {
    const jobs = (await this.deps.jobs.findEventSourced()).filter(isSchedulable);
    const base = await loadConnections(
      this.deps.connections,
      jobs.flatMap((job) => (job.trigger.connection ? [job.trigger.connection] : [])),
      null,
    );
    const wanted = new Set<string>();
    for (const job of jobs) {
      const environment = await this.#policies.environment(job);
      const catalog = inEnvironment(base, environment);
      const source = this.#sourceOf(job, catalog);
      if (!source) {
        continue;
      }
      if (source.exclusive && !(await this.#holdLease(job))) {
        continue;
      }
      wanted.add(job.id);
      const fingerprint = subscriptionFingerprint(job, catalog, environment);
      const current = this.#subscriptions.get(job.id);
      if (current?.fingerprint === fingerprint) {
        continue;
      }
      if (current) {
        await this.#unsubscribe(job.id);
      }
      this.#subscribe(job, source, fingerprint);
    }
    for (const jobId of this.#subscriptions.keys()) {
      if (!wanted.has(jobId)) {
        await this.#unsubscribe(jobId);
      }
    }
  }

  #sourceOf(job: Job, catalog: ConnectionCatalog): BoundEventSource | undefined {
    const bound = bindTrigger(this.deps.registry, job, catalog);
    if (bound.isErr()) {
      this.deps.logger.warn('Cannot bind event source', { jobId: job.id, err: bound.error });

      return undefined;
    }

    return bound.value.source;
  }

  #holdLease(job: Job): Promise<boolean> {
    return this.deps.eventSources.claim({
      key: eventSourceLeaseKey(job.id),
      ownerId: this.options.ownerId,
      now: this.deps.clock.now(),
      leaseMs: this.options.leaseMs,
    });
  }

  #subscribe(job: Job, source: BoundEventSource, fingerprint: string): void {
    const controller = new AbortController();
    const done = this.#consume(job, source, controller.signal);
    this.#subscriptions.set(job.id, {
      fingerprint,
      exclusive: source.exclusive,
      controller,
      done,
    });
    this.deps.logger.info('Event source subscribed', {
      jobId: job.id,
      type: job.trigger.type,
      connection: job.trigger.connection?.key,
    });
  }

  async #unsubscribe(jobId: string): Promise<void> {
    const subscription = this.#subscriptions.get(jobId);
    if (!subscription) {
      return;
    }
    this.#subscriptions.delete(jobId);
    subscription.controller.abort();
    await subscription.done;
    if (subscription.exclusive) {
      await this.deps.eventSources
        .release({ key: eventSourceLeaseKey(jobId), ownerId: this.options.ownerId })
        .catch((error: unknown) => {
          this.deps.logger.warn('Lease release failed', { jobId, err: error });
        });
    }
    this.deps.logger.info('Event source unsubscribed', { jobId });
  }

  async #consume(job: Job, source: BoundEventSource, signal: AbortSignal): Promise<void> {
    const emit = async (message: SourceMessage): Promise<void> => {
      const current = await this.deps.jobs.get(job.id);
      if (!current) {
        throw new Error(`Job ${job.id} no longer exists`);
      }
      const ingested = await this.deps.ingestor.ingest(current, {
        kind: 'message',
        source: job.trigger.type,
        id: message.id,
        body: message.body,
        headers: { ...message.headers },
        receivedAt: this.deps.clock.now(),
      });
      if (ingested.isErr()) {
        throw new Error(ingested.error.message);
      }
    };
    let delay = this.options.restartDelayMs;
    while (!signal.aborted) {
      try {
        await source.subscribe({ signal, secrets: this.deps.secrets, jobId: job.id, emit });
        delay = this.options.restartDelayMs;
      } catch (error: unknown) {
        if (signal.aborted) {
          return;
        }
        this.deps.logger.warn('Event source failed; restarting', {
          jobId: job.id,
          err: error,
          delayMs: delay,
        });
      }
      await sleep(delay, undefined, { signal }).catch(() => undefined);
      delay = Math.min(delay * 2, this.options.maxRestartDelayMs ?? 60_000);
    }
  }
}
