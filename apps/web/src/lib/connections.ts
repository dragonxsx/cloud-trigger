import { type ConnectionDto, client } from './api';

export async function listAllConnections(cursor?: string): Promise<ConnectionDto[]> {
  const page = await client.connections.list({
    limit: 200,
    ...(cursor !== undefined && { cursor }),
  });

  return page.nextCursor === null
    ? page.items
    : [...page.items, ...(await listAllConnections(page.nextCursor))];
}
