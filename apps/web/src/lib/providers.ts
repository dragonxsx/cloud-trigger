import { useQuery } from '@tanstack/react-query';

import { client } from './api';

export function useProviders() {
  return useQuery({
    queryKey: ['providers'],
    queryFn: () => client.providers.list({}),
    staleTime: 300_000,
  });
}
