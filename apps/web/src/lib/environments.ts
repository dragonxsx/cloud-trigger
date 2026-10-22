import { useQuery } from '@tanstack/react-query';

import { type EnvironmentDto, client, orpc } from './api';

export async function listAllEnvironments(cursor?: string): Promise<EnvironmentDto[]> {
  const page = await client.environments.list({
    limit: 200,
    ...(cursor !== undefined && { cursor }),
  });

  return page.nextCursor === null
    ? page.items
    : [...page.items, ...(await listAllEnvironments(page.nextCursor))];
}

const comparable = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

export const environmentLabel = (environment: Pick<EnvironmentDto, 'key' | 'name'>): string =>
  !environment.name
    ? environment.key
    : comparable(environment.name) === comparable(environment.key)
      ? environment.name
      : `${environment.name} (${environment.key})`;

export function useEnvironments() {
  return useQuery({
    queryKey: orpc.environments.list.key({ type: 'query' }),
    queryFn: () => listAllEnvironments(),
    staleTime: 60_000,
  });
}
