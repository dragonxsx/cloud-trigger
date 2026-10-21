import { useOnError } from '@refinedev/core';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { z } from 'zod';

import { isUnauthorized } from '../lib/errors';

const RefineKey = z.tuple([z.enum(['data', 'auth', 'access', 'audit'])], z.unknown());

const ownedByRefine = (key: unknown): boolean => RefineKey.safeParse(key).success;

export function UnauthorizedWatcher() {
  const queryClient = useQueryClient();
  const { mutate: onError } = useOnError();
  useEffect(() => {
    const report = (key: unknown, error: unknown) => {
      if (!ownedByRefine(key) && isUnauthorized(error)) {
        onError(error);
      }
    };
    const stopQueries = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'error') {
        report(event.query.queryKey, event.action.error);
      }
    });
    const stopMutations = queryClient.getMutationCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'error') {
        report(event.mutation.options.mutationKey, event.action.error);
      }
    });

    return () => {
      stopQueries();
      stopMutations();
    };
  }, [queryClient, onError]);

  return null;
}
