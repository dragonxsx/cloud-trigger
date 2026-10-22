import type { Page, PageRequest, SortOrder } from '@cloud-trigger/core';
import type { Collection, Document, Filter, WithId } from 'mongodb';
import { z } from 'zod';

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

const StoredDocument = z.looseObject({ _id: z.string() });

export async function findSortedPage<D extends { _id: string }, T>(
  collection: Collection<D>,
  filter: Filter<D>,
  query: PageRequest,
  sort: { readonly key: Document | string; readonly order: SortOrder },
  map: (doc: { readonly _id: string }) => T,
): Promise<Page<T>> {
  const [docs, total] = await Promise.all([
    collection
      .aggregate([
        { $match: filter },
        {
          $set: {
            _sortKey: sort.key,
            _sortMissing: { $eq: [{ $ifNull: [sort.key, null] }, null] },
          },
        },
        { $sort: { _sortMissing: 1, _sortKey: sort.order === 'asc' ? 1 : -1, _id: -1 } },
        { $skip: query.offset ?? 0 },
        { $limit: query.limit },
        { $unset: ['_sortKey', '_sortMissing'] },
      ])
      .toArray(),
    collection.countDocuments(filter),
  ]);

  return { items: docs.map((doc) => map(StoredDocument.parse(doc))), nextCursor: null, total };
}
