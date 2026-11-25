import {
  type Db,
  type IndexSpecification,
  MongoServerError,
  type TimeSeriesCollectionOptions,
} from 'mongodb';

const INDEX_OPTIONS_CONFLICT = 85;
const DAY_SECONDS = 86_400;

const isIndexOptionsConflict = (error: unknown): boolean =>
  error instanceof MongoServerError && error.code === INDEX_OPTIONS_CONFLICT;

export async function ensureTtlIndex(
  db: Db,
  collection: string,
  index: { readonly name: string; readonly key: IndexSpecification; readonly days: number },
): Promise<void> {
  const expireAfterSeconds = index.days * DAY_SECONDS;
  try {
    await db
      .collection(collection)
      .createIndex(index.key, { name: index.name, expireAfterSeconds });
  } catch (error: unknown) {
    if (!isIndexOptionsConflict(error)) {
      throw error;
    }
    await db.command({ collMod: collection, index: { name: index.name, expireAfterSeconds } });
  }
}

export async function ensureTimeSeriesTtl(
  db: Db,
  collection: string,
  options: { readonly days: number; readonly timeseries: TimeSeriesCollectionOptions },
): Promise<void> {
  const expireAfterSeconds = options.days * DAY_SECONDS;
  const exists = await db.listCollections({ name: collection }).hasNext();
  if (exists) {
    await db.command({ collMod: collection, expireAfterSeconds });

    return;
  }
  await db.createCollection(collection, { timeseries: options.timeseries, expireAfterSeconds });
}
