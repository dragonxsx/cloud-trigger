import {
  ConnectionSpec,
  GroupSpec,
  JobSpec,
  type Page,
  type PageRequest,
  type Persistence,
  type SecretLeaf,
  WorkflowSpec,
} from '@cloud-trigger/core';

import { type SealingDeps, SecretSealer, sealedPersistence } from './sealed-persistence.js';

export interface ResealCount {
  readonly scanned: number;
  readonly resealed: number;
  readonly skipped: number;
}

export type ResealReport = Readonly<
  Record<
    'jobs' | 'connections' | 'groups' | 'workflows' | 'workflowRuns' | 'authSettings',
    ResealCount
  >
>;

const PAGE_SIZE = 100;

async function* everyItem<T>(
  list: (page: PageRequest) => Promise<Page<T>>,
): AsyncGenerator<T, void, undefined> {
  let cursor: string | undefined;
  do {
    const page = await list({ limit: PAGE_SIZE, ...(cursor !== undefined && { cursor }) });
    yield* page.items;
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
}

const stale = (visit: (leaf: SecretLeaf) => unknown, needsReseal: (v: unknown) => boolean) => {
  let found = false;
  visit((secret) => {
    found ||= needsReseal(secret);

    return secret;
  });

  return found;
};

async function resealEach<T>(
  items: AsyncIterable<T>,
  needsReseal: (item: T) => boolean,
  write: (item: T) => Promise<boolean>,
): Promise<ResealCount> {
  let scanned = 0;
  let resealed = 0;
  let skipped = 0;
  for await (const item of items) {
    scanned += 1;
    if (!needsReseal(item)) {
      continue;
    }
    if (await write(item)) {
      resealed += 1;
    } else {
      skipped += 1;
    }
  }

  return { scanned, resealed, skipped };
}

export async function resealSecrets(inner: Persistence, deps: SealingDeps): Promise<ResealReport> {
  const sealer = new SecretSealer(deps.registry, deps.cipher);
  const { fields, needsReseal } = sealer;
  const sealed = sealedPersistence(inner, deps);

  const jobs = await resealEach(
    everyItem((page) => inner.jobs.list(page)),
    (job) => stale((leaf) => fields.job(job, leaf), needsReseal),
    async (job) =>
      (
        await sealed.jobs.update(
          job.id,
          { spec: JobSpec.parse(sealer.open(job)), updatedAt: job.updatedAt },
          job.version,
        )
      ).isOk(),
  );
  const connections = await resealEach(
    everyItem((page) => inner.connections.list(page)),
    (connection) => stale((leaf) => fields.connection(connection, leaf), needsReseal),
    async (connection) =>
      (
        await sealed.connections.update(
          connection.key,
          {
            spec: ConnectionSpec.parse(sealer.open(connection)),
            updatedAt: connection.updatedAt,
          },
          connection.version,
        )
      ).isOk(),
  );
  const groups = await resealEach(
    everyItem((page) => inner.groups.list(page)),
    (group) => stale((leaf) => fields.group(group, leaf), needsReseal),
    async (group) =>
      (
        await sealed.groups.update(
          group.id,
          { spec: GroupSpec.parse(sealer.open(group)), updatedAt: group.updatedAt },
          group.version,
        )
      ).isOk(),
  );
  const workflows = await resealEach(
    everyItem((page) => inner.workflows.list(page)),
    (workflow) => stale((leaf) => fields.workflow(workflow, leaf), needsReseal),
    async (workflow) =>
      (
        await sealed.workflows.update(
          workflow.id,
          {
            spec: WorkflowSpec.parse(sealer.open(workflow)),
            inlineJobIds: workflow.inlineJobIds,
            updatedAt: workflow.updatedAt,
          },
          workflow.version,
        )
      ).isOk(),
  );
  const workflowRuns = await resealEach(
    everyItem((page) => inner.workflowRuns.list(page)),
    (run) => stale((leaf) => fields.workflowRun(run, leaf), needsReseal),
    async (run) =>
      (
        await sealed.workflowRuns.update(
          { ...sealer.openWorkflowRun(run), version: run.version + 1 },
          run.version,
        )
      ).isOk(),
  );
  const settings = await inner.authSettings.get();
  const authSettings = await resealEach(
    (async function* () {
      if (settings) {
        yield settings;
      }
    })(),
    (current) => needsReseal(current.sessionSecret),
    async (current) =>
      (
        await sealed.authSettings.update(
          { ...sealer.openSettings(current), version: current.version + 1 },
          current.version,
        )
      ).isOk(),
  );

  return { jobs, connections, groups, workflows, workflowRuns, authSettings };
}
