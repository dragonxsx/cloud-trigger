import {
  type NotFoundError,
  type Result,
  type StoredEntity,
  type VersionConflictError,
  err,
  notFound,
  ok,
  versionConflict,
} from '@cloud-trigger/core';
import { MongoBulkWriteError, MongoServerError, type WriteError } from 'mongodb';

const DUPLICATE_KEY = 11000;

const isReadonlyArray = <T>(value: T | readonly T[]): value is readonly T[] => Array.isArray(value);

export const writeErrorsOf = (error: MongoBulkWriteError): readonly WriteError[] =>
  isReadonlyArray(error.writeErrors) ? error.writeErrors : [error.writeErrors];

export const isDuplicateKeyError = (error: unknown): boolean => {
  if (error instanceof MongoBulkWriteError) {
    return writeErrorsOf(error).every((e) => e.code === DUPLICATE_KEY);
  }

  return error instanceof MongoServerError && error.code === DUPLICATE_KEY;
};

export async function unlessDuplicateKey<T, E>(
  write: () => Promise<T>,
  onDuplicate: () => E,
): Promise<Result<T, E>> {
  try {
    return ok(await write());
  } catch (error: unknown) {
    if (isDuplicateKeyError(error)) {
      return err(onDuplicate());
    }
    throw error;
  }
}

interface Countable {
  countDocuments(filter: { _id: string }, options: { limit: number }): Promise<number>;
}

export async function casMissed(
  collection: Countable,
  entity: StoredEntity,
  id: string,
): Promise<Result<never, VersionConflictError | NotFoundError>> {
  return (await collection.countDocuments({ _id: id }, { limit: 1 }))
    ? err(versionConflict(entity, id))
    : err(notFound(entity, id));
}

export const caseInsensitiveMatch = (search: string) => ({
  $regex: RegExp.escape(search),
  $options: 'i',
});
