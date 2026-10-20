import {
  type ConfigError,
  type ConfigIssue,
  type ConflictError,
  type Clock,
  type EnvironmentRepository,
  type JobId,
  type JobRepository,
  type NotFoundError,
  type Page,
  type ProviderRegistry,
  type Result,
  type VersionConflictError,
  type Workflow,
  type WorkflowEffect,
  type WorkflowId,
  type WorkflowQuery,
  type WorkflowRepository,
  type WorkflowRun,
  type WorkflowRunId,
  type WorkflowRunQuery,
  type WorkflowRunRepository,
  WorkflowSpec,
  cancelWorkflowRun,
  configErrorFromZod,
  decideApproval,
  err,
  newWorkflowId,
  ok,
  validateWorkflowGraph,
} from '@cloud-trigger/core';

import { unknownEnvironment } from './config-validation.js';
import type { JobService } from './job-service.js';
import type { WorkflowRuntime } from './workflow-runtime.js';

export interface WorkflowServiceDeps {
  readonly workflows: WorkflowRepository;
  readonly workflowRuns: WorkflowRunRepository;
  readonly jobs: JobRepository;
  readonly environments?: EnvironmentRepository | undefined;
  readonly registry: ProviderRegistry;
  readonly clock: Clock;
  readonly jobService: JobService;
  readonly runtime: WorkflowRuntime;
}

const invalid = (issues: ConfigIssue[]): ConfigError => ({
  code: 'invalid_config',
  message: 'Invalid workflow',
  issues,
});
const notFound = (what: string, id: string): NotFoundError => ({
  code: 'not_found',
  message: `${what} ${id} not found`,
});
const conflict = (message: string): ConflictError => ({ code: 'conflict', message });

const prefixIssues = (prefix: string, error: ConfigError): ConfigIssue[] =>
  error.issues.map((issue) => ({
    path: issue.path ? `${prefix}.${issue.path}` : prefix,
    message: issue.message,
  }));

export class WorkflowService {
  constructor(private readonly deps: WorkflowServiceDeps) {}

  list(query: WorkflowQuery): Promise<Page<Workflow>> {
    return this.deps.workflows.list(query);
  }

  async get(id: WorkflowId): Promise<Result<Workflow, NotFoundError>> {
    const workflow = await this.deps.workflows.get(id);

    return workflow ? ok(workflow) : err(notFound('Workflow', id));
  }

  async #validate(
    raw: unknown,
    id: WorkflowId,
  ): Promise<Result<{ spec: WorkflowSpec; nextFireAt: Date | null }, ConfigError>> {
    const parsed = WorkflowSpec.safeParse(raw);
    if (!parsed.success) {
      return err(configErrorFromZod(parsed.error, 'workflow'));
    }
    const spec = parsed.data;
    const graph = validateWorkflowGraph(spec);
    if (graph.isErr()) {
      return err(graph.error);
    }
    const issues: ConfigIssue[] = await unknownEnvironment(
      this.deps.environments,
      spec.environment,
    );
    for (const [index, node] of spec.nodes.entries()) {
      if (node.kind === 'job' && !(await this.deps.jobs.get(node.jobId))) {
        issues.push({ path: `nodes.${index}.jobId`, message: `Job ${node.jobId} does not exist` });
      }
    }
    let nextFireAt: Date | null = null;
    if (spec.schedule) {
      const bound = this.deps.registry
        .get('trigger', spec.schedule.type)
        .andThen((provider) => provider.bind(spec.schedule?.config));
      if (bound.isErr()) {
        issues.push(
          ...(bound.error.code === 'unknown_provider'
            ? [{ path: 'schedule.type', message: bound.error.message }]
            : prefixIssues('schedule.config', bound.error)),
        );
      } else if (bound.value.matches || bound.value.source) {
        issues.push({ path: 'schedule.type', message: 'Workflows need a time-based trigger' });
      } else if (spec.enabled) {
        nextFireAt = bound.value.nextFireAt({
          after: this.deps.clock.now(),
          lastFiredAt: null,
          fireCount: 0,
          jobId: id,
        });
      }
    }

    return issues.length > 0 ? err(invalid(issues)) : ok({ spec, nextFireAt });
  }

  #inlineSpec(spec: WorkflowSpec, key: string) {
    const index = spec.nodes.findIndex((node) => node.key === key);
    const node = spec.nodes[index];
    if (node?.kind !== 'inline') {
      return undefined;
    }

    return {
      index,
      spec: {
        ...node.job,
        environment: node.job.environment ?? spec.environment,
        name: `${spec.name} · ${node.label ?? node.key}`,
        enabled: true,
        trigger: { type: 'manual', config: {} },
      },
    };
  }

  async #syncInlineJobs(
    id: WorkflowId,
    spec: WorkflowSpec,
    previous: Readonly<Record<string, JobId>>,
  ): Promise<
    Result<
      Record<string, JobId>,
      ConfigError | ConflictError | NotFoundError | VersionConflictError
    >
  > {
    const next: Record<string, JobId> = {};
    const created: JobId[] = [];
    for (const node of spec.nodes) {
      const inline = this.#inlineSpec(spec, node.key);
      if (!inline) {
        continue;
      }
      const existingId = previous[node.key];
      const existing = existingId === undefined ? undefined : await this.deps.jobs.get(existingId);
      const saved = existing
        ? await this.deps.jobService.update(existing.id, inline.spec, existing.version, {
            asWorkflow: true,
          })
        : await this.deps.jobService.create(inline.spec, { workflowId: id });
      if (saved.isErr()) {
        for (const jobId of created) {
          await this.deps.jobService.delete(jobId, { asWorkflow: true });
        }

        return saved.error.code === 'invalid_config'
          ? err(invalid(prefixIssues(`nodes.${inline.index}.job`, saved.error)))
          : err(saved.error);
      }
      if (!existing) {
        created.push(saved.value.id);
      }
      next[node.key] = saved.value.id;
    }
    for (const [key, jobId] of Object.entries(previous)) {
      if (next[key] === undefined) {
        await this.deps.jobService.delete(jobId, { asWorkflow: true });
      }
    }

    return ok(next);
  }

  async create(
    raw: unknown,
  ): Promise<Result<Workflow, ConfigError | ConflictError | NotFoundError | VersionConflictError>> {
    const id = newWorkflowId();
    const validated = await this.#validate(raw, id);
    if (validated.isErr()) {
      return err(validated.error);
    }
    const { spec, nextFireAt } = validated.value;
    const inline = await this.#syncInlineJobs(id, spec, {});
    if (inline.isErr()) {
      return err(inline.error);
    }
    const now = this.deps.clock.now();
    const workflow: Workflow = {
      ...spec,
      id,
      inlineJobIds: inline.value,
      nextFireAt,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.workflows.insert(workflow);

    return ok(workflow);
  }

  async update(
    id: WorkflowId,
    raw: unknown,
    expectedVersion: number,
  ): Promise<Result<Workflow, ConfigError | ConflictError | NotFoundError | VersionConflictError>> {
    const current = await this.deps.workflows.get(id);
    if (!current) {
      return err(notFound('Workflow', id));
    }
    if (current.version !== expectedVersion) {
      return err({ code: 'version_conflict', message: `Workflow ${id} was modified concurrently` });
    }
    const validated = await this.#validate(raw, id);
    if (validated.isErr()) {
      return err(validated.error);
    }
    const { spec, nextFireAt } = validated.value;
    const inline = await this.#syncInlineJobs(id, spec, current.inlineJobIds);
    if (inline.isErr()) {
      return err(inline.error);
    }

    return this.deps.workflows.update(
      id,
      { spec, inlineJobIds: inline.value, nextFireAt, updatedAt: this.deps.clock.now() },
      expectedVersion,
    );
  }

  async delete(id: WorkflowId): Promise<boolean> {
    const current = await this.deps.workflows.get(id);
    if (!current) {
      return false;
    }
    for (const jobId of Object.values(current.inlineJobIds)) {
      await this.deps.jobService.delete(jobId, { asWorkflow: true });
    }

    return this.deps.workflows.delete(id);
  }

  async start(id: WorkflowId): Promise<Result<WorkflowRun, NotFoundError | ConflictError>> {
    const workflow = await this.deps.workflows.get(id);
    if (!workflow) {
      return err(notFound('Workflow', id));
    }
    if (!workflow.enabled) {
      return err(conflict(`Workflow ${id} is disabled`));
    }
    const run = await this.deps.runtime.start(workflow, { reason: 'manual' });

    return run ? ok(run) : err(conflict('Workflow run already exists'));
  }

  listRuns(query: WorkflowRunQuery): Promise<Page<WorkflowRun>> {
    return this.deps.workflowRuns.list(query);
  }

  async getRun(id: WorkflowRunId): Promise<Result<WorkflowRun, NotFoundError>> {
    const run = await this.deps.workflowRuns.get(id);

    return run ? ok(run) : err(notFound('Workflow run', id));
  }

  async decide(
    id: WorkflowRunId,
    node: string,
    p: { approved: boolean; by: string; reason?: string | undefined },
  ): Promise<Result<WorkflowRun, NotFoundError | ConflictError>> {
    if (!(await this.deps.workflowRuns.get(id))) {
      return err(notFound('Workflow run', id));
    }
    const changed = await this.deps.runtime.mutate(id, (run) =>
      decideApproval(run, node, { ...p, now: this.deps.clock.now() }),
    );

    return changed ? ok(changed.run) : err(conflict(`Node "${node}" is not waiting for approval`));
  }

  async cancel(id: WorkflowRunId): Promise<Result<WorkflowRun, NotFoundError | ConflictError>> {
    if (!(await this.deps.workflowRuns.get(id))) {
      return err(notFound('Workflow run', id));
    }
    const changed = await this.deps.runtime.mutate(id, (run) =>
      cancelWorkflowRun(run, this.deps.clock.now()),
    );
    if (!changed) {
      return err(conflict('Workflow run has already finished'));
    }
    await this.#cancelRuns(changed.cancels);

    return ok(changed.run);
  }

  async #cancelRuns(effects: readonly WorkflowEffect[]): Promise<void> {
    for (const effect of effects) {
      if (effect.type === 'cancel_run') {
        await this.deps.jobService.cancelRun(effect.runId);
      }
    }
  }
}
