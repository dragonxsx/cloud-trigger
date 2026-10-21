import type { HttpError } from '@refinedev/core';

export const unfieldedError = (
  error: HttpError | null,
  fields: readonly string[],
): string | null => {
  if (error === null) {
    return null;
  }
  const shownOnField = Object.keys(error.errors ?? {}).some((path) => fields.includes(path));

  return shownOnField ? null : error.message;
};
