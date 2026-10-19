import {
  type DomainEvent,
  type EventBus,
  JobId,
  type JobChangedEvent,
  LocalEventHub,
  Run,
  type Unsubscribe,
  isLocalOnlyEvent,
} from '@cloud-trigger/core';
import type { ChangeStream, Collection, Document } from 'mongodb';
import { z } from 'zod';

import type { JobDocument, RunDocument } from './documents.js';

const RunChange = z.object({
  operationType: z.enum(['insert', 'replace', 'update']),
  fullDocument: z.looseObject({ _id: z.string() }),
});
const JobOperation = z.enum(['insert', 'replace', 'update', 'delete']);
const JobChange = z.object({
  operationType: JobOperation,
  documentKey: z.object({ _id: JobId }),
});

const JOB_CHANGE_FOR_OPERATION = {
  insert: 'created',
  replace: 'updated',
  update: 'updated',
  delete: 'deleted',
} as const satisfies Record<z.output<typeof JobOperation>, JobChangedEvent['change']>;

const RUN_CHANGES_EXCEPT_HEARTBEATS: Document[] = [
  {
    $match: {
      $or: [
        { operationType: { $in: ['insert', 'replace'] } },
        { operationType: 'update', 'updateDescription.updatedFields.updatedAt': { $exists: true } },
      ],
    },
  },
];

export class MongoChangeStreamEventBus implements EventBus {
  readonly #hub = new LocalEventHub();
  readonly #streams: ChangeStream[] = [];
  #closed = false;

  constructor(
    private readonly runs: Collection<RunDocument>,
    private readonly jobs: Collection<JobDocument>,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  start(): void {
    this.#watch(
      () => this.runs.watch(RUN_CHANGES_EXCEPT_HEARTBEATS, { fullDocument: 'updateLookup' }),
      (change) => {
        const parsed = RunChange.safeParse(change);
        if (!parsed.success) {
          return;
        }
        const { _id, ...rest } = parsed.data.fullDocument;
        const run = Run.safeParse({ ...rest, id: _id });
        if (run.success) {
          this.#hub.emit({ type: 'run.changed', run: run.data });
        }
      },
    );
    this.#watch(
      () => this.jobs.watch([], { fullDocument: 'default' }),
      (change) => {
        const parsed = JobChange.safeParse(change);
        if (!parsed.success) {
          return;
        }
        this.#hub.emit({
          type: 'job.changed',
          jobId: parsed.data.documentKey._id,
          change: JOB_CHANGE_FOR_OPERATION[parsed.data.operationType],
        });
      },
    );
  }

  async publish(event: DomainEvent): Promise<void> {
    if (isLocalOnlyEvent(event)) {
      this.#hub.emit(event);
    }
  }

  subscribe(handler: (event: DomainEvent) => void): Unsubscribe {
    return this.#hub.subscribe(handler);
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all(this.#streams.map((s) => s.close()));
  }

  #watch(open: () => ChangeStream, onChange: (change: unknown) => void): void {
    const stream = open();
    this.#streams.push(stream);
    stream.on('change', onChange);
    stream.on('error', (error: unknown) => {
      this.onError(error);
      void stream.close();
      if (!this.#closed) {
        setTimeout(() => this.#watch(open, onChange), 1_000);
      }
    });
  }
}
