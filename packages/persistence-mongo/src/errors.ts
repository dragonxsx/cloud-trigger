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
