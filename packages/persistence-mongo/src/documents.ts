import { Job, Run, type RunningRun, RunningRun as RunningRunSchema } from '@cloud-trigger/core';
import type { DistributedOmit } from 'type-fest';

export interface SchedulerLease {
  readonly owner: string;
  readonly until: Date;
}

export type JobDocument = Omit<Job, 'id'> & { _id: string; schedulerLease: SchedulerLease | null };
/** Persistence-only: `<jobId>:exec` / `<jobId>:buffer`, unique-indexed. */
export type RunDocument = DistributedOmit<Run, 'id'> & { _id: string; overlapSlot?: string };

export const toJobDocument = (job: Job): JobDocument => {
  const { id, ...rest } = job;

  return { ...rest, _id: id, schedulerLease: null };
};

export const fromJobDocument = (doc: JobDocument): Job => {
  const { _id, schedulerLease: _lease, ...rest } = doc;

  return Job.parse({ ...rest, id: _id });
};

export const toRunDocument = (run: Run): RunDocument => {
  const { id, ...rest } = run;

  return { ...rest, _id: id };
};

export const fromRunDocument = (doc: RunDocument): Run => {
  const { _id, overlapSlot: _slot, ...rest } = doc;

  return Run.parse({ ...rest, id: _id });
};

export const fromRunningDocument = (doc: RunDocument): RunningRun => {
  const { _id, overlapSlot: _slot, ...rest } = doc;

  return RunningRunSchema.parse({ ...rest, id: _id });
};
