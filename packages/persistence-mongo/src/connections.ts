import {
  type ConflictError,
  Connection,
  type ConnectionQuery,
  type ConnectionRepository,
  type ConnectionSpec,
  type NotFoundError,
  type Page,
  type Result,
  type VersionConflictError,
  connectionUpdateFields,
  err,
  nameTaken,
  notFound,
  ok,
  versionConflict,
} from '@cloud-trigger/core';
import type { Collection, Filter } from 'mongodb';

import { type Stored, documentParser, toDocument } from './documents.js';
import { caseInsensitiveMatch, unlessDuplicateKey } from './errors.js';

export type ConnectionDocument = Stored<Connection>;

const fromDocument = documentParser(Connection);

export class MongoConnectionRepository implements ConnectionRepository {
  static readonly collectionName = 'connections';

  constructor(private readonly connections: Collection<ConnectionDocument>) {}

  static async ensureIndexes(connections: Collection<ConnectionDocument>): Promise<void> {
    await connections.createIndexes([
      { key: { key: 1 }, name: 'key', unique: true },
      { key: { type: 1, key: 1 }, name: 'type' },
    ]);
  }

  async insert(connection: Connection): Promise<Result<Connection, ConflictError>> {
    const inserted = await unlessDuplicateKey(
      () => this.connections.insertOne(toDocument(connection)),
      () => nameTaken('connection', connection.key),
    );

    return inserted.map(() => connection);
  }

  async get(key: string): Promise<Connection | undefined> {
    const doc = await this.connections.findOne({ key });

    return doc ? fromDocument(doc) : undefined;
  }

  async getMany(keys: readonly string[]): Promise<readonly Connection[]> {
    if (keys.length === 0) {
      return [];
    }
    const docs = await this.connections.find({ key: { $in: [...keys] } }).toArray();

    return docs.map(fromDocument);
  }

  async list(query: ConnectionQuery): Promise<Page<Connection>> {
    const filter: Filter<ConnectionDocument> = {};
    if (query.search) {
      filter.$or = [
        { key: caseInsensitiveMatch(query.search) },
        { name: caseInsensitiveMatch(query.search) },
      ];
    }
    if (query.type) {
      filter.type = query.type;
    }
    const pageFilter: Filter<ConnectionDocument> = query.cursor
      ? { ...filter, key: { $gt: query.cursor } }
      : filter;
    const [docs, total] = await Promise.all([
      this.connections
        .find(pageFilter)
        .sort({ key: 1 })
        .skip(query.cursor ? 0 : (query.offset ?? 0))
        .limit(query.limit + 1)
        .toArray(),
      this.connections.countDocuments(filter),
    ]);
    const items = docs.slice(0, query.limit).map(fromDocument);

    return {
      items,
      nextCursor: docs.length > query.limit ? (items.at(-1)?.key ?? null) : null,
      total,
    };
  }

  async update(
    key: string,
    update: { spec: ConnectionSpec; updatedAt: Date },
    expectedVersion: number,
  ): Promise<Result<Connection, VersionConflictError | NotFoundError>> {
    const doc = await this.connections.findOneAndUpdate(
      { key, version: expectedVersion },
      { $set: { ...connectionUpdateFields(update, expectedVersion), key } },
      { returnDocument: 'after' },
    );
    if (doc) {
      return ok(fromDocument(doc));
    }

    return (await this.connections.countDocuments({ key }, { limit: 1 }))
      ? err(versionConflict('Connection', key))
      : err(notFound('Connection', key));
  }

  async delete(key: string): Promise<boolean> {
    const res = await this.connections.deleteOne({ key });

    return res.deletedCount === 1;
  }
}
