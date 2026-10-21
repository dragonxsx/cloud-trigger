import { useList } from '@refinedev/core';
import { useMemo } from 'react';

import type { GroupDto } from './api';

export function useGroups(): { groups: readonly GroupDto[]; isLoading: boolean } {
  const { result, query } = useList<GroupDto>({
    resource: 'groups',
    pagination: { mode: 'off' },
    queryOptions: { staleTime: 60_000 },
  });

  return { groups: result.data, isLoading: query.isLoading };
}

export function useGroupsById(): ReadonlyMap<string, GroupDto> {
  const { groups } = useGroups();

  return useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);
}
