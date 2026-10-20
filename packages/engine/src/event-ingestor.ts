import { createHash } from 'node:crypto';

import {
  type ConnectionRepository,
  type BoundTrigger,
  type Clock,
  type DomainError,
  type GroupRepository,
  type InboundRequest,
  type Job,
  type JobId,
  type JobRepository,
  type Logger,
  MAX_EVENT_BODY_BYTES,
  type NotFoundError,
  type ProviderRegistry,
  type RateLimiter,
  type Result,
  type RunEvent,
  type RunId,
  type RunRepository,
  type SecretResolver,
  err,
  isSchedulable,
  newPendingRun,
  newRunId,
  ok,
} from '@cloud-trigger/core';

import { loadTrigger } from './config-validation.js';
import { PolicyResolver } from './policies.js';

export interface EventIngestorDeps {
  readonly jobs: JobRepository;
  readonly runs: RunRepository;
  readonly registry: ProviderRegistry;
  readonly connections?: ConnectionRepository | undefined;
  readonly secrets: SecretResolver;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly groups?: GroupRepository | undefined;
  readonly rateLimiter?: RateLimiter | undefined;
  readonly defaultWebhookPerSecond?: number | undefined;
}

export interface Ingested {
  readonly runId: RunId | null;
  readonly duplicate: boolean;
}

export type JobPausedError = DomainError<'job_paused'>;
export type UnauthorizedError = DomainError<'unauthorized'>;
export type PayloadTooLargeError = DomainError<'payload_too_large'>;
export type RateLimitedError = DomainError<'rate_limited'> & {
  readonly retryAfterSeconds: number;
};
export type IngestError = NotFoundError | JobPausedError | PayloadTooLargeError;
export type WebhookError = IngestError | UnauthorizedError | RateLimitedError;

export const eventKey = (jobId: string, deliveryId: string) => `event:${jobId}:${deliveryId}`;

export const webhookRateLimitKey = (jobId: string) => `hook:${jobId}`;

const MAX_DELIVERY_ID = 200;
const normaliseDeliveryId = (id: string): string =>
  id.length <= MAX_DELIVERY_ID ? id : createHash('sha256').update(id).digest('hex');

export class EventIngestor {
  readonly #policies: PolicyResolver;

  constructor(private readonly deps: EventIngestorDeps) {
    this.#policies = new PolicyResolver(deps.groups, deps.clock);
  }

  async ingest(job: Job, event: RunEvent): Promise<Result<Ingested, IngestError>> {
    if (!isSchedulable(job)) {
      return err({ code: 'job_paused', message: `Job ${job.id} is paused or disabled` });
    }
    if (Buffer.byteLength(event.body, 'utf8') > MAX_EVENT_BODY_BYTES) {
      return err({
        code: 'payload_too_large',
        message: `Event body exceeds ${MAX_EVENT_BODY_BYTES} bytes`,
      });
    }
    const now = this.deps.clock.now();
    const { policy } = await this.#policies.resolve(job);
    const inserted = await this.deps.runs.insert(
      newPendingRun({
        id: newRunId(),
        job,
        reason: 'event',
        scheduledAt: now,
        idempotencyKey: eventKey(job.id, normaliseDeliveryId(event.id)),
        event,
        sla: policy.sla,
        now,
      }),
      { durableKey: true },
    );
    if (inserted.isErr()) {
      return ok({ runId: null, duplicate: true });
    }
    this.deps.logger.info('Event run queued', {
      jobId: job.id,
      runId: inserted.value.id,
      source: event.source,
    });

    return ok({ runId: inserted.value.id, duplicate: false });
  }

  async #bindTrigger(job: Job): Promise<BoundTrigger | undefined> {
    const bound = await loadTrigger(
      this.deps.registry,
      this.deps.connections,
      job,
      await this.#policies.environment(job),
    );

    return bound.isOk() ? bound.value : undefined;
  }

  async receiveWebhook(
    jobId: JobId,
    request: Omit<InboundRequest, 'receivedAt'>,
  ): Promise<Result<Ingested, WebhookError>> {
    const notFound: NotFoundError = { code: 'not_found', message: 'No webhook at this address' };
    const job = await this.deps.jobs.get(jobId);
    const trigger = job && (await this.#bindTrigger(job));
    if (!job || !trigger?.inbound) {
      return err(notFound);
    }
    const receivedAt = this.deps.clock.now();
    const verdict = await trigger.inbound(
      { ...request, receivedAt },
      { secrets: this.deps.secrets, now: receivedAt },
    );
    if (!verdict.accepted) {
      return verdict.reason === 'unauthorized'
        ? err(notFound)
        : err({ code: 'unauthorized', message: 'Invalid webhook signature' });
    }
    const perSecond = verdict.perSecond ?? this.deps.defaultWebhookPerSecond;
    if (perSecond !== undefined && this.deps.rateLimiter) {
      const acquired = await this.deps.rateLimiter.tryAcquire(
        webhookRateLimitKey(job.id),
        { perSecond },
        receivedAt,
      );
      if (!acquired.ok) {
        return err({
          code: 'rate_limited',
          message: 'Too many webhook deliveries',
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((acquired.retryAt.getTime() - receivedAt.getTime()) / 1000),
          ),
        });
      }
    }

    return this.ingest(job, {
      kind: 'webhook',
      source: job.trigger.type,
      id: verdict.deliveryId,
      body: request.body,
      headers: { ...request.headers },
      receivedAt,
    });
  }
}
