import type { Page, PageRequest } from '@cloud-trigger/core';
import type { Collection, Filter, WithId } from 'mongodb';

export async function findNewestFirstPage<D extends { _id: string }, T>(
  collection: Collection<D>,
  filter: Filter<D>,
  query: PageRequest,
  map: (doc: WithId<D>) => T,
): Promise<Page<T>> {
  const pageFilter: Filter<D> = query.cursor ? { ...filter, _id: { $lt: query.cursor } } : filter;
  const [docs, total] = await Promise.all([
    collection
      .find(pageFilter)
      .sort({ _id: -1 })
      .skip(query.cursor ? 0 : (query.offset ?? 0))
      .limit(query.limit + 1)
      .toArray(),
    collection.countDocuments(filter),
  ]);
  const items = docs.slice(0, query.limit);
  const hasMore = docs.length > query.limit;

  return {
    items: items.map(map),
    nextCursor: hasMore ? (items.at(-1)?._id ?? null) : null,
    total,
  };
}
