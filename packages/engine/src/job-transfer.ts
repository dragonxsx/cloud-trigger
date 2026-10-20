import { isDeepStrictEqual } from 'node:util';

import {
  type ConnectionRepository,
  type UnitOfWork,
  nonAtomicUnitOfWork,
  type GroupId,
  type GroupRepository,
  type Job,
  type JobId,
  type JobRepository,
  JobSpec,
  type ProviderRegistry,
  isRecord,
  newJobId,
} from '@cloud-trigger/core';
import { z } from 'zod';

import { loadTrigger } from './config-validation.js';
import type { JobService } from './job-service.js';

export const ExportedJob = JobSpec.omit({ groupId: true }).extend({
  group: z
    .string()
    .nullable()
    .default(null)
    .describe('Group name; IDs differ between environments.'),
  upstream: z
    .record(z.string(), z.string())
    .default({})
    .describe('Trigger config path → upstream job name, resolved to that job on import.'),
});
export type ExportedJob = z.output<typeof ExportedJob>;

export const ImportMode = z.enum(['upsert', 'replace']);
export type ImportMode = z.output<typeof ImportMode>;

export interface ImportIssue {
  readonly document: number;
  readonly name: string | null;
  readonly path: string;
  readonly message: string;
}

export interface ImportResult {
  readonly dryRun: boolean;
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly unchanged: readonly string[];
  readonly deleted: readonly string[];
  readonly issues: readonly ImportIssue[];
}

export interface JobTransferDeps {
  readonly jobs: JobRepository;
  readonly groups?: GroupRepository | undefined;
  readonly registry: ProviderRegistry;
  readonly connections?: ConnectionRepository | undefined;
  readonly service: JobService;
  readonly unitOfWork?: UnitOfWork | undefined;
}

class ImportRolledBack extends Error {}

interface Plan {
  readonly index: number;
  readonly doc: ExportedJob;
  readonly previous: Job | undefined;
  readonly groupId: GroupId | null;
}

const REDACTED = '***';

const containsRedacted = (value: unknown): boolean =>
  value === REDACTED ||
  (Array.isArray(value) && value.some(containsRedacted)) ||
  (isRecord(value) && Object.values(value).some(containsRedacted));

const setAtPath = (target: unknown, path: readonly string[], value: string): unknown => {
  const [head, ...rest] = path;
  if (head === undefined) {
    return value;
  }
  const record = isRecord(target) ? target : {};

  return { ...record, [head]: setAtPath(record[head], rest, value) };
};

const specOf = (doc: ExportedJob, groupId: GroupId | null): JobSpec => {
  const { group: _group, upstream: _upstream, ...spec } = doc;

  return { ...spec, groupId };
};

const withUpstream = (spec: JobSpec, ids: ReadonlyMap<string, JobId>, doc: ExportedJob): JobSpec =>
  Object.entries(doc.upstream).reduce<JobSpec>((acc, [path, name]) => {
    const id = ids.get(name);

    return id === undefined
      ? acc
      : {
          ...acc,
          trigger: { ...acc.trigger, config: setAtPath(acc.trigger.config, path.split('.'), id) },
        };
  }, spec);

const cyclic = (plans: readonly Plan[], existing: ReadonlyMap<string, JobId>): Plan[] => {
  const inFile = new Set(plans.map((p) => p.doc.name));
  const known = new Set([...existing.keys()].filter((name) => !inFile.has(name)));
  let pending = [...plans];
  for (;;) {
    const ready = pending.filter((p) =>
      Object.values(p.doc.upstream).every((name) => known.has(name) || !inFile.has(name)),
    );
    if (ready.length === 0) {
      return pending;
    }
    for (const plan of ready) {
      known.add(plan.doc.name);
    }
    pending = pending.filter((p) => !ready.includes(p));
  }
};

async function allJobs(
  jobs: JobRepository,
  filter: { tag?: string | undefined; groupId?: GroupId | undefined },
): Promise<Job[]> {
  const all: Job[] = [];
  let cursor: string | undefined;
  do {
    const page = await jobs.list({ ...filter, limit: 200, cursor });
    all.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);

  return all.filter((job) => job.workflowId === null);
}

export class JobTransfer {
  constructor(private readonly deps: JobTransferDeps) {}

  async export(
    filter: { tag?: string | undefined; groupId?: GroupId | undefined },
    redact: (job: Job) => Job,
  ): Promise<ExportedJob[]> {
    const jobs = await allJobs(this.deps.jobs, filter);
    const groupNames = new Map<GroupId, string>();
    const docs: ExportedJob[] = [];
    for (const job of jobs.toSorted((a, b) => a.name.localeCompare(b.name))) {
      const { id: _id, groupId, ...rest } = redact(job);
      if (groupId !== null && !groupNames.has(groupId)) {
        const group = await this.deps.groups?.get(groupId);
        groupNames.set(groupId, group?.name ?? groupId);
      }
      const spec = JobSpec.parse(rest);
      docs.push({
        ...spec,
        group: groupId === null ? null : (groupNames.get(groupId) ?? null),
        upstream: await this.#upstreamNames(job),
      });
    }

    return docs;
  }

  async #upstreamNames(job: Job): Promise<Record<string, string>> {
    const bound = await loadTrigger(this.deps.registry, this.deps.connections, job);
    const refs = bound.isOk() ? (bound.value.upstream?.() ?? []) : [];
    const names: Record<string, string> = {};
    for (const ref of refs) {
      const parent = job.upstreamJobIds.find((id) => id === ref.jobId);
      const found = parent === undefined ? undefined : await this.deps.jobs.get(parent);
      if (found) {
        names[ref.path] = found.name;
      }
    }

    return names;
  }

  async import(
    raw: readonly unknown[],
    opts: { mode: ImportMode; dryRun: boolean; restore: (next: JobSpec, previous: Job) => JobSpec },
  ): Promise<ImportResult> {
    const issues: ImportIssue[] = [];
    const empty = { dryRun: opts.dryRun, created: [], updated: [], unchanged: [], deleted: [] };
    const docs = this.#parse(raw, issues);
    if (issues.length > 0) {
      return { ...empty, issues };
    }
    const plans = await this.#plan(docs, issues);
    const existing = await allJobs(this.deps.jobs, {});
    const ids = new Map<string, JobId>(existing.map((job) => [job.name, job.id]));
    await this.#validate(plans, ids, opts.restore, issues);
    if (issues.length > 0) {
      return { ...empty, issues };
    }
    const names = new Set(plans.map((p) => p.doc.name));
    const toDelete = opts.mode === 'replace' ? existing.filter((job) => !names.has(job.name)) : [];
    const created: string[] = [];
    const updated: string[] = [];
    const unchanged: string[] = [];
    for (const plan of plans) {
      const { doc, previous } = plan;
      if (!previous) {
        created.push(doc.name);
      } else if (
        isDeepStrictEqual(
          JobSpec.parse(opts.restore(withUpstream(specOf(doc, plan.groupId), ids, doc), previous)),
          JobSpec.parse(previous),
        )
      ) {
        unchanged.push(doc.name);
      } else {
        updated.push(doc.name);
      }
    }
    const outcome = { created, updated, unchanged, deleted: toDelete.map((job) => job.name) };
    if (opts.dryRun) {
      return { dryRun: true, ...outcome, issues };
    }
    const unitOfWork = this.deps.unitOfWork ?? nonAtomicUnitOfWork;
    const failed = { dryRun: false, created, updated, unchanged, deleted: [], issues };
    try {
      await unitOfWork.transaction(async () => {
        await this.#apply(plans, ids, new Set(unchanged), opts.restore, issues);
        if (issues.length > 0) {
          throw new ImportRolledBack();
        }
        for (const job of toDelete) {
          await this.deps.service.delete(job.id);
        }
      });
    } catch (error: unknown) {
      if (error instanceof ImportRolledBack) {
        return unitOfWork.atomic ? { ...failed, created: [], updated: [] } : failed;
      }
      throw error;
    }

    return { dryRun: false, ...outcome, issues };
  }

  #parse(raw: readonly unknown[], issues: ImportIssue[]): ExportedJob[] {
    const docs: ExportedJob[] = [];
    const seen = new Set<string>();
    raw.forEach((value, document) => {
      const parsed = ExportedJob.safeParse(value);
      if (!parsed.success) {
        const name = isRecord(value) && typeof value['name'] === 'string' ? value['name'] : null;
        for (const issue of parsed.error.issues) {
          issues.push({
            document,
            name,
            path: issue.path.map(String).join('.'),
            message: issue.message,
          });
        }

        return;
      }
      if (seen.has(parsed.data.name)) {
        issues.push({
          document,
          name: parsed.data.name,
          path: 'name',
          message: 'Duplicate job name in this file',
        });
      }
      seen.add(parsed.data.name);
      docs.push(parsed.data);
    });

    return docs;
  }

  async #plan(docs: readonly ExportedJob[], issues: ImportIssue[]): Promise<Plan[]> {
    const plans: Plan[] = [];
    for (const [index, doc] of docs.entries()) {
      const matches = await this.deps.jobs.findByName(doc.name);
      if (matches.length > 1) {
        issues.push({
          document: index,
          name: doc.name,
          path: 'name',
          message: `${matches.length} existing jobs share this name`,
        });
      }
      let groupId: GroupId | null = null;
      if (doc.group !== null) {
        const group = await this.deps.groups?.findByName(doc.group);
        if (group) {
          groupId = group.id;
        } else {
          issues.push({
            document: index,
            name: doc.name,
            path: 'group',
            message: `Group "${doc.group}" does not exist`,
          });
        }
      }
      plans.push({ index, doc, previous: matches[0], groupId });
    }

    return plans;
  }

  async #validate(
    plans: readonly Plan[],
    existing: ReadonlyMap<string, JobId>,
    restore: (next: JobSpec, previous: Job) => JobSpec,
    issues: ImportIssue[],
  ): Promise<void> {
    const inFile = new Set(plans.map((p) => p.doc.name));
    for (const plan of cyclic(plans, existing)) {
      issues.push({
        document: plan.index,
        name: plan.doc.name,
        path: 'upstream',
        message: 'Upstream jobs form a cycle',
      });
    }
    const placeholders = new Map<string, JobId>(
      [...inFile].map((name) => [name, existing.get(name) ?? newJobId()]),
    );
    for (const plan of plans) {
      const { doc, index } = plan;
      for (const [path, name] of Object.entries(doc.upstream)) {
        if (!inFile.has(name) && !existing.has(name)) {
          issues.push({
            document: index,
            name: doc.name,
            path: `upstream.${path}`,
            message: `Upstream job "${name}" does not exist`,
          });
        }
      }
      const ids = new Map([...existing, ...placeholders]);
      const candidate = withUpstream(specOf(doc, plan.groupId), ids, doc);
      const spec = plan.previous ? restore(candidate, plan.previous) : candidate;
      const validated = await this.deps.service.validate(spec);
      if (validated.isErr()) {
        for (const issue of validated.error.issues) {
          issues.push({ document: index, name: doc.name, ...issue });
        }
      }
      const configs = [
        spec.trigger.config,
        spec.input.config,
        spec.target.config,
        ...spec.notifications.map((n) => n.notifier.config),
      ];
      if (configs.some(containsRedacted)) {
        issues.push({
          document: index,
          name: doc.name,
          path: 'secrets',
          message: plan.previous
            ? 'A redacted *** value does not match a stored secret; set it or use {{secret:NAME}}'
            : 'Redacted *** values need a real value or {{secret:NAME}} for a new job',
        });
      }
    }
  }

  async #apply(
    plans: readonly Plan[],
    ids: Map<string, JobId>,
    unchanged: ReadonlySet<string>,
    restore: (next: JobSpec, previous: Job) => JobSpec,
    issues: ImportIssue[],
  ): Promise<void> {
    let pending = [...plans];
    while (pending.length > 0) {
      const ready = pending.filter((p) =>
        Object.values(p.doc.upstream).every((name) => ids.has(name)),
      );
      if (ready.length === 0) {
        for (const p of pending) {
          issues.push({
            document: p.index,
            name: p.doc.name,
            path: 'upstream',
            message: 'Upstream jobs form a cycle',
          });
        }

        return;
      }
      for (const plan of ready) {
        await this.#write(plan, ids, unchanged, restore, issues);
      }
      pending = pending.filter((p) => !ready.includes(p));
    }
  }

  async #write(
    plan: Plan,
    ids: Map<string, JobId>,
    unchanged: ReadonlySet<string>,
    restore: (next: JobSpec, previous: Job) => JobSpec,
    issues: ImportIssue[],
  ): Promise<void> {
    const { doc, previous } = plan;
    if (unchanged.has(doc.name)) {
      return;
    }
    const spec = withUpstream(specOf(doc, plan.groupId), ids, doc);
    const written = previous
      ? await this.deps.service.update(previous.id, restore(spec, previous), previous.version)
      : await this.deps.service.create(spec);
    if (written.isOk()) {
      ids.set(doc.name, written.value.id);

      return;
    }
    const error = written.error;
    const details = 'issues' in error ? error.issues : [{ path: '', message: error.message }];
    for (const issue of details) {
      issues.push({ document: plan.index, name: doc.name, ...issue });
    }
  }
}
