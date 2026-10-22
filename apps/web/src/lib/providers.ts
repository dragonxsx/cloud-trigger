import { useQuery } from '@tanstack/react-query';

import { orpc } from './api';

export function useProviders() {
  return useQuery(orpc.providers.list.queryOptions({ input: {}, staleTime: 300_000 }));
}
