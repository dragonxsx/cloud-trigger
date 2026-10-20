import {
  AuthSettings,
  Connection,
  Group,
  Job,
  NotificationDelivery,
  type Page,
  type Persistence,
  type ProviderRegistry,
  type SecretCipher,
  SecretFields,
  type SecretOpenError,
  Workflow,
  WorkflowRun,
  isSealed,
  sealedKeyId,
} from '@cloud-trigger/core';

export interface SealingDeps {
  readonly registry: ProviderRegistry;
  readonly cipher: SecretCipher;
}

export class SecretUnavailableError extends Error {
  constructor(readonly reason: SecretOpenError) {
    super(
      reason.code === 'secret_key_unknown'
        ? `A stored secret was encrypted with key ${reason.keyId}, which is not in DATA_ENCRYPTION_KEY or DATA_ENCRYPTION_PREVIOUS_KEYS`
        : `A stored secret encrypted with key ${reason.keyId} failed authentication; it was altered or the key is wrong`,
    );
    this.name = 'SecretUnavailableError';
  }
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);

  return proto === Object.prototype || proto === null;
};

const mapPage = <T>(page: Page<T>, map: (item: T) => T): Page<T> => ({
  ...page,
  items: page.items.map(map),
});

export class SecretSealer {
  readonly fields: SecretFields;

  constructor(
    registry: ProviderRegistry,
    private readonly cipher: SecretCipher,
  ) {
    this.fields = new SecretFields(registry);
  }

  readonly seal = (secret: unknown): unknown => {
    if (typeof secret !== 'string' || sealedKeyId(secret) === this.cipher.currentKeyId) {
      return secret;
    }

    return this.cipher.seal(isSealed(secret) ? this.#openString(secret) : secret);
  };

  readonly needsReseal = (secret: unknown): boolean =>
    typeof secret === 'string' && sealedKeyId(secret) !== this.cipher.currentKeyId;

  open(value: unknown): unknown {
    if (isSealed(value)) {
      return this.#openString(value);
    }
    if (Array.isArray(value)) {
      return value.map((item: unknown) => this.open(item));
    }
    if (isPlainRecord(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, this.open(v)]));
    }

    return value;
  }

  readonly openJob = (job: Job): Job => Job.parse(this.open(job));
  readonly openConnection = (connection: Connection): Connection =>
    Connection.parse(this.open(connection));
  readonly openGroup = (group: Group): Group => Group.parse(this.open(group));
  readonly openWorkflow = (workflow: Workflow): Workflow => Workflow.parse(this.open(workflow));
  readonly openWorkflowRun = (run: WorkflowRun): WorkflowRun => WorkflowRun.parse(this.open(run));
  readonly openDelivery = (delivery: NotificationDelivery): NotificationDelivery =>
    NotificationDelivery.parse(this.open(delivery));
  readonly openSettings = (settings: AuthSettings): AuthSettings =>
    AuthSettings.parse(this.open(settings));

  readonly sealSettings = (settings: AuthSettings): AuthSettings => {
    const sessionSecret = this.seal(settings.sessionSecret);

    return {
      ...settings,
      sessionSecret: typeof sessionSecret === 'string' ? sessionSecret : settings.sessionSecret,
    };
  };

  #openString(sealed: string): string {
    const opened = this.cipher.open(sealed);
    if (opened.isErr()) {
      throw new SecretUnavailableError(opened.error);
    }

    return opened.value;
  }
}

export function sealedPersistence(inner: Persistence, deps: SealingDeps): Persistence {
  const sealer = new SecretSealer(deps.registry, deps.cipher);
  const { fields, seal } = sealer;
  const openJobs = (jobs: readonly Job[]): readonly Job[] => jobs.map(sealer.openJob);
  const { jobs, connections, groups, workflows, workflowRuns, outbox, authSettings, schedule } =
    inner;

  return {
    ...inner,
    jobs: {
      insert: (job) => jobs.insert(fields.job(job, seal)),
      get: async (id) => {
        const job = await jobs.get(id);

        return job && sealer.openJob(job);
      },
      list: async (query) => mapPage(await jobs.list(query), sealer.openJob),
      update: async (id, update, expectedVersion) =>
        (
          await jobs.update(id, { ...update, spec: fields.job(update.spec, seal) }, expectedVersion)
        ).map(sealer.openJob),
      delete: (id) => jobs.delete(id),
      patchSchedule: (id, patch, extra) => jobs.patchSchedule(id, patch, extra),
      recordFailure: (id, p) => jobs.recordFailure(id, p),
      findDependants: async (jobId) => openJobs(await jobs.findDependants(jobId)),
      findByConnection: async (key, endpoint) =>
        openJobs(await jobs.findByConnection(key, endpoint)),
      findByEnvironment: async (environment) => openJobs(await jobs.findByEnvironment(environment)),
      findEventSourced: async () => openJobs(await jobs.findEventSourced()),
      findByName: async (name) => openJobs(await jobs.findByName(name)),
      findStaleJobs: async (p) => openJobs(await jobs.findStaleJobs(p)),
      updateSlaState: (job, update) => jobs.updateSlaState(job, update),
    },
    schedule: {
      claimDue: async (p) => openJobs(await schedule.claimDue(p)),
      commitFire: (p) => schedule.commitFire(p),
    },
    connections: {
      insert: async (connection) =>
        (await connections.insert(fields.connection(connection, seal))).map(sealer.openConnection),
      get: async (key) => {
        const connection = await connections.get(key);

        return connection && sealer.openConnection(connection);
      },
      getMany: async (keys) => (await connections.getMany(keys)).map(sealer.openConnection),
      list: async (query) => mapPage(await connections.list(query), sealer.openConnection),
      update: async (key, update, expectedVersion) =>
        (
          await connections.update(
            key,
            { ...update, spec: fields.connection(update.spec, seal) },
            expectedVersion,
          )
        ).map(sealer.openConnection),
      delete: (key) => connections.delete(key),
      findByEnvironment: async (environment) =>
        (await connections.findByEnvironment(environment)).map(sealer.openConnection),
    },
    groups: {
      insert: async (group) =>
        (await groups.insert(fields.group(group, seal))).map(sealer.openGroup),
      get: async (id) => {
        const group = await groups.get(id);

        return group && sealer.openGroup(group);
      },
      findByName: async (name) => {
        const group = await groups.findByName(name);

        return group && sealer.openGroup(group);
      },
      list: async (query) => mapPage(await groups.list(query), sealer.openGroup),
      update: async (id, update, expectedVersion) =>
        (
          await groups.update(
            id,
            { ...update, spec: fields.group(update.spec, seal) },
            expectedVersion,
          )
        ).map(sealer.openGroup),
      delete: (id) => groups.delete(id),
      findByConnection: async (key, endpoint) =>
        (await groups.findByConnection(key, endpoint)).map(sealer.openGroup),
      findByEnvironment: async (environment) =>
        (await groups.findByEnvironment(environment)).map(sealer.openGroup),
    },
    workflows: {
      insert: (workflow) => workflows.insert(fields.workflow(workflow, seal)),
      get: async (id) => {
        const workflow = await workflows.get(id);

        return workflow && sealer.openWorkflow(workflow);
      },
      list: async (query) => mapPage(await workflows.list(query), sealer.openWorkflow),
      update: async (id, change, expectedVersion) =>
        (
          await workflows.update(
            id,
            { ...change, spec: fields.workflow(change.spec, seal) },
            expectedVersion,
          )
        ).map(sealer.openWorkflow),
      delete: (id) => workflows.delete(id),
      findByEnvironment: async (environment) =>
        (await workflows.findByEnvironment(environment)).map(sealer.openWorkflow),
      findDue: async (p) => (await workflows.findDue(p)).map(sealer.openWorkflow),
      advanceSchedule: (id, p) => workflows.advanceSchedule(id, p),
    },
    workflowRuns: {
      insert: async (run) =>
        (await workflowRuns.insert(fields.workflowRun(run, seal))).map(sealer.openWorkflowRun),
      get: async (id) => {
        const run = await workflowRuns.get(id);

        return run && sealer.openWorkflowRun(run);
      },
      list: async (query) => mapPage(await workflowRuns.list(query), sealer.openWorkflowRun),
      update: async (next, expectedVersion) =>
        (await workflowRuns.update(fields.workflowRun(next, seal), expectedVersion)).map(
          sealer.openWorkflowRun,
        ),
      findExpiredApprovals: async (p) =>
        (await workflowRuns.findExpiredApprovals(p)).map(sealer.openWorkflowRun),
      findWithQueuedNodes: async (p) =>
        (await workflowRuns.findWithQueuedNodes(p)).map(sealer.openWorkflowRun),
    },
    outbox: {
      enqueue: (entries) =>
        outbox.enqueue(entries.map((delivery) => fields.delivery(delivery, seal))),
      claimNext: async (p) => {
        const delivery = await outbox.claimNext(p);

        return delivery && sealer.openDelivery(delivery);
      },
      complete: (claimed, now) => outbox.complete(claimed, now),
      fail: (claimed, p) => outbox.fail(claimed, p),
      listByRun: async (runId) => (await outbox.listByRun(runId)).map(sealer.openDelivery),
      listOpenByConnection: async (key) =>
        (await outbox.listOpenByConnection(key)).map(sealer.openDelivery),
    },
    authSettings: {
      get: async () => {
        const settings = await authSettings.get();

        return settings && sealer.openSettings(settings);
      },
      create: async (settings) =>
        (await authSettings.create(sealer.sealSettings(settings))).map(sealer.openSettings),
      update: async (next, expectedVersion) =>
        (await authSettings.update(sealer.sealSettings(next), expectedVersion)).map(
          sealer.openSettings,
        ),
    },
  };
}
