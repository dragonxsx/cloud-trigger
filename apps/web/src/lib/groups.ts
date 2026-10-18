import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { type GroupDto, client } from './api';

export function useGroupsById(): ReadonlyMap<string, GroupDto> {
  const groups = useQuery({
    queryKey: ['groups', 'all'],
    queryFn: () => client.groups.list({ limit: 200 }),
    staleTime: 60_000,
  });

  return useMemo(() => new Map((groups.data?.items ?? []).map((g) => [g.id, g])), [groups.data]);
}
