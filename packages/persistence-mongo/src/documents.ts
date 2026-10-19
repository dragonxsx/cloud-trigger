import { Job, Run, RunningRun } from '@cloud-trigger/core';
import type { DistributedOmit } from 'type-fest';
import type { z } from 'zod';

export type Stored<T extends { readonly id: string }> = Omit<T, 'id'> & { _id: string };

export const toDocument = <T extends { readonly id: string }>(entity: T): Stored<T> => {
  const { id, ...rest } = entity;

  return { ...rest, _id: id };
};

export const documentParser =
  <S extends z.ZodType>(schema: S) =>
  (doc: { readonly _id: string }): z.output<S> =>
    schema.parse({ ...doc, id: doc._id });

export interface SchedulerLease {
  readonly owner: string;
  readonly until: Date;
}

export type JobDocument = Stored<Job> & { schedulerLease: SchedulerLease | null };
export type RunDocument = DistributedOmit<Run, 'id'> & { _id: string; overlapSlot?: string };

export const toJobDocument = (job: Job): JobDocument => ({
  ...toDocument(job),
  schedulerLease: null,
});

export const fromJobDocument = documentParser(Job);
export const toRunDocument = (run: Run): RunDocument => {
  const { id, ...rest } = run;

  return { ...rest, _id: id };
};
export const fromRunDocument = documentParser(Run);
export const fromRunningDocument = documentParser(RunningRun);
