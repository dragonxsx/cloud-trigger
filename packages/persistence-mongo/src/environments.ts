import {
  type ConflictError,
  Environment,
  type EnvironmentQuery,
  type EnvironmentRepository,
  type EnvironmentSpec,
  type NotFoundError,
  type Page,
  type Result,
  type VersionConflictError,
  environmentUpdateFields,
  err,
  nameTaken,
  notFound,
  ok,
  versionConflict,
} from '@cloud-trigger/core';
import type { Collection, Filter } from 'mongodb';

import { type Stored, documentParser, toDocument } from './documents.js';
import { caseInsensitiveMatch, unlessDuplicateKey } from './errors.js';

export type EnvironmentDocument = Stored<Environment>;

const fromDocument = documentParser(Environment);

export class MongoEnvironmentRepository implements EnvironmentRepository {
  static readonly collectionName = 'environments';

  constructor(private readonly environments: Collection<EnvironmentDocument>) {}

  static async ensureIndexes(environments: Collection<EnvironmentDocument>): Promise<void> {
    await environments.createIndexes([{ key: { key: 1 }, name: 'key', unique: true }]);
  }

  async insert(environment: Environment): Promise<Result<Environment, ConflictError>> {
    const inserted = await unlessDuplicateKey(
      () => this.environments.insertOne(toDocument(environment)),
      () => nameTaken('environment', environment.key),
    );

    return inserted.map(() => environment);
  }

  async get(key: string): Promise<Environment | undefined> {
    const doc = await this.environments.findOne({ key });

    return doc ? fromDocument(doc) : undefined;
  }

  async list(query: EnvironmentQuery): Promise<Page<Environment>> {
    const filter: Filter<EnvironmentDocument> = {};
    if (query.search) {
      filter.$or = [
        { key: caseInsensitiveMatch(query.search) },
        { name: caseInsensitiveMatch(query.search) },
      ];
    }
    const pageFilter: Filter<EnvironmentDocument> = query.cursor
      ? { ...filter, key: { $gt: query.cursor } }
      : filter;
    const [docs, total] = await Promise.all([
      this.environments
        .find(pageFilter)
        .sort({ key: 1 })
        .skip(query.cursor ? 0 : (query.offset ?? 0))
        .limit(query.limit + 1)
        .toArray(),
      this.environments.countDocuments(filter),
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
    update: { spec: EnvironmentSpec; updatedAt: Date },
    expectedVersion: number,
  ): Promise<Result<Environment, VersionConflictError | NotFoundError>> {
    const doc = await this.environments.findOneAndUpdate(
      { key, version: expectedVersion },
      { $set: { ...environmentUpdateFields(update, expectedVersion), key } },
      { returnDocument: 'after' },
    );
    if (doc) {
      return ok(fromDocument(doc));
    }

    return (await this.environments.countDocuments({ key }, { limit: 1 }))
      ? err(versionConflict('Environment', key))
      : err(notFound('Environment', key));
  }

  async delete(key: string): Promise<boolean> {
    const res = await this.environments.deleteOne({ key });

    return res.deletedCount === 1;
  }
}
