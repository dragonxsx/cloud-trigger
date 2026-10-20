import { useQuery } from '@tanstack/react-query';

import { type EnvironmentDto, client } from './api';

export const ENVIRONMENTS_KEY = ['environments'];

export async function listAllEnvironments(cursor?: string): Promise<EnvironmentDto[]> {
  const page = await client.environments.list({
    limit: 200,
    ...(cursor !== undefined && { cursor }),
  });

  return page.nextCursor === null
    ? page.items
    : [...page.items, ...(await listAllEnvironments(page.nextCursor))];
}

export const environmentLabel = (environment: Pick<EnvironmentDto, 'key' | 'name'>): string =>
  environment.name ? `${environment.name} (${environment.key})` : environment.key;

export function useEnvironments() {
  return useQuery({
    queryKey: ENVIRONMENTS_KEY,
    queryFn: () => listAllEnvironments(),
    staleTime: 60_000,
  });
}
