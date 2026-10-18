import type { RunAnalytics } from './analytics.js';
import type { DecisionLog } from './decisions.js';
import type { EventSourceLeases } from './event-sources.js';
import type { EventBus } from './events.js';
import type { GroupRepository, RateLimiter } from './groups.js';
import type { JobRepository, ScheduleStore } from './jobs.js';
import type { NotificationOutbox } from './notifications.js';
import type { RunQueue, RunRepository } from './runs.js';
import type { UnitOfWork } from './unit-of-work.js';
import type { WorkflowRepository, WorkflowRunRepository } from './workflows.js';

export interface StartableEventBus extends EventBus {
  readonly start: () => void;
}

export interface Persistence {
  readonly jobs: JobRepository;
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
  readonly events: StartableEventBus;
  readonly unitOfWork: UnitOfWork;
  readonly migrate: () => Promise<void>;
  readonly ping: () => Promise<boolean>;
  readonly close: () => Promise<void>;
}
