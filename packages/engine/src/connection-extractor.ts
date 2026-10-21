import { isDeepStrictEqual } from 'node:util';

import {
  type Clock,
  type ConfigError,
  type ConfigIssue,
  type ConflictError,
  type Connection,
  type ConnectionRepository,
  type ConnectionSpec,
  type ExtractSlot,
  type Job,
  type JobId,
  type JobRepository,
  type NotFoundError,
  type ProviderRegistry,
  type Result,
  type UnitOfWork,
  type VersionConflictError,
  SecretFields,
  createConnection,
  err,
  extractJobConnection,
  extractionSuggestion,
  jobConnectionRefs,
  newConnectionId,
  nonAtomicUnitOfWork,
  notFound,
  ok,
  redactBySchema,
  slugKey,
  uniqueEndpointKey,
  versionConflict,
} from '@cloud-trigger/core';

import type { ConnectionService } from './connection-service.js';
import type { JobService } from './job-service.js';

export interface ConnectionExtractorDeps {
  readonly jobs: JobRepository;
  readonly connections: ConnectionRepository;
  readonly registry: ProviderRegistry;
  readonly clock: Clock;
  readonly jobService: JobService;
  readonly connectionService: ConnectionService;
  readonly unitOfWork?: UnitOfWork | undefined;
}

export interface ExtractConnectionInput {
  readonly id: JobId;
  readonly slot: ExtractSlot;
  readonly key?: string | undefined;
  readonly name?: string | undefined;
  readonly endpoint?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly expectedVersion: number;
  readonly dryRun: boolean;
}

export interface SimilarConnection {
  readonly key: string;
  readonly name: string;
  readonly match: 'identical' | 'same_address';
}

export interface ExtractConnectionResult {
  readonly dryRun: boolean;
  readonly connection: Connection;
  readonly endpoint: string;
  readonly job: Job;
  readonly similar: readonly SimilarConnection[];
  readonly warnings: readonly ConfigIssue[];
}

export type ExtractConnectionError =
  | ConfigError
  | NotFoundError
  | VersionConflictError
  | ConflictError;

const KEY_PROBES = 20;
const SIMILAR_PAGE = 200;

const invalid = (issues: readonly ConfigIssue[]): ConfigError => ({
  code: 'invalid_config',
  message: 'Cannot extract a connection',
  issues,
});

const prefixed = (prefix: string, issues: readonly ConfigIssue[]): ConfigIssue[] =>
  issues.map((issue) => ({
    path: issue.path ? `${prefix}.${issue.path}` : prefix,
    message: issue.message,
  }));

const SLOT_WARNINGS: Record<ExtractSlot['kind'], readonly ConfigIssue[]> = {
  target: [],
  trigger: [{ path: 'trigger', message: 'The event source reconnects once after the change' }],
  notification: [],
};

class ExtractRolledBack extends Error {
  constructor(readonly error: ExtractConnectionError) {
    super(error.message);
  }
}

export class ConnectionExtractor {
  readonly #fields: SecretFields;

  constructor(private readonly deps: ConnectionExtractorDeps) {
    this.#fields = new SecretFields(deps.registry);
  }

  async extract(
    input: ExtractConnectionInput,
  ): Promise<Result<ExtractConnectionResult, ExtractConnectionError>> {
    const job = await this.deps.jobs.get(input.id);
    if (!job) {
      return err(notFound('Job', input.id));
    }
    if (job.workflowId !== null) {
      return err({
        code: 'conflict',
        message: `Job ${job.id} belongs to workflow ${job.workflowId}; edit the workflow instead`,
      });
    }
    if (job.version !== input.expectedVersion) {
      return err(versionConflict('Job', job.id));
    }
    const key = await this.#key(job, input);
    if (key.isErr()) {
      return err(key.error);
    }
    const draft = extractJobConnection(this.deps.registry, job, {
      slot: input.slot,
      key: key.value,
      name: input.name,
      endpoint: input.endpoint,
      baseUrl: input.baseUrl,
      now: this.deps.clock.now(),
    });
    if (draft.isErr()) {
      return err(draft.error);
    }
    const { spec, endpoint } = draft.value;
    const connectionSpec = this.deps.connectionService.validate(draft.value.connection);
    if (connectionSpec.isErr()) {
      return err(invalid(prefixed('connection', connectionSpec.error.issues)));
    }
    const connection = createConnection({
      id: newConnectionId(),
      spec: connectionSpec.value,
      now: this.deps.clock.now(),
    });
    const validated = await this.deps.jobService.validate(spec, job.id, 1, [connection]);
    if (validated.isErr()) {
      return err(validated.error);
    }
    const similar = await this.#similar(connectionSpec.value);
    const warnings = [...draft.value.warnings, ...SLOT_WARNINGS[input.slot.kind]];
    if (input.dryRun) {
      return ok({
        dryRun: true,
        connection,
        endpoint,
        job: {
          ...job,
          ...validated.value.spec,
          connectionRefs: jobConnectionRefs(this.deps.registry, validated.value.spec),
        },
        similar,
        warnings,
      });
    }

    return this.#commit(job, connectionSpec.value, spec, input.expectedVersion).then((saved) =>
      saved.map(({ created, updated }) => ({
        dryRun: false,
        connection: created,
        endpoint,
        job: updated,
        similar,
        warnings,
      })),
    );
  }

  async #key(job: Job, input: ExtractConnectionInput): Promise<Result<string, ConfigError>> {
    if (input.key !== undefined) {
      return (await this.deps.connections.get(input.key))
        ? err(invalid([{ path: 'key', message: `A connection "${input.key}" already exists` }]))
        : ok(input.key);
    }
    const base = slugKey(
      extractionSuggestion(this.deps.registry, job, input.slot) ?? job.name,
      'connection',
    );
    const seen = new Set<string>();
    for (;;) {
      const candidates: string[] = [];
      for (let i = 0; i < KEY_PROBES; i += 1) {
        const candidate = uniqueEndpointKey(base, seen);
        seen.add(candidate);
        candidates.push(candidate);
      }
      const taken = new Set(
        (await this.deps.connections.getMany(candidates)).map((connection) => connection.key),
      );
      const free = candidates.find((candidate) => !taken.has(candidate));
      if (free !== undefined) {
        return ok(free);
      }
    }
  }

  async #similar(spec: ConnectionSpec): Promise<SimilarConnection[]> {
    const provider = this.deps.registry.get('connection', spec.type);
    if (provider.isErr()) {
      return [];
    }
    const { address } = provider.value;
    const schema = this.#fields.schema('connection', spec.type);
    const view = (config: unknown): unknown => redactBySchema(schema, config);
    const mine = view(spec.config);
    const myAddress = address?.(spec.config);
    const page = await this.deps.connections.list({ type: spec.type, limit: SIMILAR_PAGE });

    return page.items.flatMap((existing): SimilarConnection[] => {
      const match = isDeepStrictEqual(view(existing.config), mine)
        ? 'identical'
        : myAddress !== undefined && address?.(existing.config) === myAddress
          ? 'same_address'
          : undefined;

      return match === undefined ? [] : [{ key: existing.key, name: existing.name, match }];
    });
  }

  async #commit(
    job: Job,
    connection: ConnectionSpec,
    spec: unknown,
    expectedVersion: number,
  ): Promise<Result<{ created: Connection; updated: Job }, ExtractConnectionError>> {
    const unitOfWork = this.deps.unitOfWork ?? nonAtomicUnitOfWork;
    let created: Connection | undefined;
    try {
      return ok(
        await unitOfWork.transaction(async () => {
          const inserted = await this.deps.connectionService.create(connection);
          if (inserted.isErr()) {
            throw new ExtractRolledBack(inserted.error);
          }
          created = inserted.value;
          const updated = await this.deps.jobService.update(job.id, spec, expectedVersion);
          if (updated.isErr()) {
            throw new ExtractRolledBack(updated.error);
          }

          return { created: inserted.value, updated: updated.value };
        }),
      );
    } catch (error: unknown) {
      if (created && !unitOfWork.atomic) {
        await this.deps.connectionService.delete(created.key).catch(() => undefined);
      }
      if (!(error instanceof ExtractRolledBack)) {
        throw error;
      }

      return err(error.error);
    }
  }
}
