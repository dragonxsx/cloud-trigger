import {
  ConnectionListQuery,
  RunListQuery,
  UpdateConnectionInput,
  UpdateGroupInput,
  UpdateJobInput,
  UpdateWorkflowInput,
  WorkflowRunListQuery,
} from '@cloud-trigger/api-contract';
import {
  ConnectionKey,
  ConnectionSpec,
  GroupId,
  GroupSpec,
  JobId,
  JobSpec,
  RunId,
  WorkflowId,
  WorkflowRunId,
  WorkflowSpec,
  toError,
} from '@cloud-trigger/core';
import { ORPCError } from '@orpc/client';
import type { BaseRecord, CrudFilter, DataProvider, HttpError } from '@refinedev/core';
import { z } from 'zod';

import { client } from '../lib/api';
import { configIssues } from '../lib/errors';

interface ResourceAdapter {
  readonly list: (p: {
    limit: number;
    offset: number;
    filters: Record<string, unknown>;
  }) => Promise<{ data: readonly BaseRecord[]; total: number }>;
  readonly getOne: (id: string) => Promise<BaseRecord>;
  readonly create?: (variables: unknown) => Promise<BaseRecord>;
  readonly update?: (id: string, variables: unknown) => Promise<BaseRecord>;
  readonly deleteOne?: (id: string) => Promise<BaseRecord>;
}

const JobFilters = z.object({
  search: z.string().optional(),
  groupId: GroupId.optional(),
  tag: z.string().optional(),
  enabled: z.boolean().optional(),
  slaBreached: z.boolean().optional(),
});
const RunFilters = RunListQuery.pick({
  jobId: true,
  status: true,
  reason: true,
  late: true,
  acknowledged: true,
});

const jobs: ResourceAdapter = {
  list: async ({ limit, offset, filters }) => {
    const page = await client.jobs.list({ limit, offset, ...JobFilters.parse(filters) });

    return { data: page.items, total: page.total };
  },
  getOne: (id) => client.jobs.get({ id: JobId.parse(id) }),
  create: (variables) => client.jobs.create(JobSpec.parse(variables)),
  update: (id, variables) =>
    client.jobs.update(
      UpdateJobInput.parse({ ...z.record(z.string(), z.unknown()).parse(variables), id }),
    ),
  deleteOne: async (id) => {
    const jobId = JobId.parse(id);
    await client.jobs.delete({ id: jobId });

    return { id: jobId };
  },
};

const GroupFilters = z.object({ search: z.string().optional() });

const groups: ResourceAdapter = {
  list: async ({ limit, offset, filters }) => {
    const page = await client.groups.list({ limit, offset, ...GroupFilters.parse(filters) });

    return { data: page.items, total: page.total };
  },
  getOne: (id) => client.groups.get({ id: GroupId.parse(id) }),
  create: (variables) => client.groups.create(GroupSpec.parse(variables)),
  update: (id, variables) =>
    client.groups.update(
      UpdateGroupInput.parse({ ...z.record(z.string(), z.unknown()).parse(variables), id }),
    ),
  deleteOne: async (id) => {
    const groupId = GroupId.parse(id);
    await client.groups.delete({ id: groupId });

    return { id: groupId };
  },
};

const ConnectionFilters = ConnectionListQuery.pick({ search: true, type: true });

const connections: ResourceAdapter = {
  list: async ({ limit, offset, filters }) => {
    const page = await client.connections.list({
      limit,
      offset,
      ...ConnectionFilters.parse(filters),
    });

    return { data: page.items.map((c) => ({ ...c, id: c.key })), total: page.total };
  },
  getOne: async (key) => {
    const connection = await client.connections.get({ key: ConnectionKey.parse(key) });

    return { ...connection, id: connection.key };
  },
  create: async (variables) => {
    const created = await client.connections.create(ConnectionSpec.parse(variables));

    return { ...created, id: created.key };
  },
  update: async (key, variables) => {
    const updated = await client.connections.update(
      UpdateConnectionInput.parse({ ...z.record(z.string(), z.unknown()).parse(variables), key }),
    );

    return { ...updated, id: updated.key };
  },
  deleteOne: async (key) => {
    await client.connections.delete({ key: ConnectionKey.parse(key) });

    return { id: key };
  },
};

const runs: ResourceAdapter = {
  list: async ({ limit, offset, filters }) => {
    const parsed = RunFilters.parse(filters);
    const page = await client.runs.list({
      limit,
      offset,
      ...(parsed.jobId !== undefined && { jobId: parsed.jobId }),
      ...(parsed.status !== undefined && { status: parsed.status }),
      ...(parsed.reason !== undefined && { reason: parsed.reason }),
      ...(parsed.late !== undefined && { late: parsed.late }),
      ...(parsed.acknowledged !== undefined && { acknowledged: parsed.acknowledged }),
    });

    return { data: page.items, total: page.total };
  },
  getOne: (id) => client.runs.get({ id: RunId.parse(id) }),
};

const WorkflowFilters = z.object({ search: z.string().optional() });

const workflows: ResourceAdapter = {
  list: async ({ limit, offset, filters }) => {
    const page = await client.workflows.list({ limit, offset, ...WorkflowFilters.parse(filters) });

    return { data: page.items, total: page.total };
  },
  getOne: (id) => client.workflows.get({ id: WorkflowId.parse(id) }),
  create: (variables) => client.workflows.create(WorkflowSpec.parse(variables)),
  update: (id, variables) =>
    client.workflows.update(
      UpdateWorkflowInput.parse({ ...z.record(z.string(), z.unknown()).parse(variables), id }),
    ),
  deleteOne: async (id) => {
    const workflowId = WorkflowId.parse(id);
    await client.workflows.delete({ id: workflowId });

    return { id: workflowId };
  },
};

const WorkflowRunFilters = WorkflowRunListQuery.pick({ workflowId: true, status: true });

const workflowRuns: ResourceAdapter = {
  list: async ({ limit, offset, filters }) => {
    const parsed = WorkflowRunFilters.parse(filters);
    const page = await client.workflowRuns.list({
      limit,
      offset,
      ...(parsed.workflowId !== undefined && { workflowId: parsed.workflowId }),
      ...(parsed.status !== undefined && { status: parsed.status }),
    });

    return { data: page.items, total: page.total };
  },
  getOne: (id) => client.workflowRuns.get({ id: WorkflowRunId.parse(id) }),
};

const RESOURCES: Readonly<Record<string, ResourceAdapter>> = {
  jobs,
  runs,
  groups,
  connections,
  workflows,
  'workflow-runs': workflowRuns,
};

function adapter(resource: string): ResourceAdapter {
  const found = RESOURCES[resource];
  if (!found) {
    throw new Error(`Unknown resource "${resource}"`);
  }

  return found;
}

const filterObject = (filters: readonly CrudFilter[] | undefined): Record<string, unknown> =>
  Object.fromEntries(
    (filters ?? []).flatMap((f) =>
      'field' in f && f.value !== undefined && f.value !== '' ? [[f.field, f.value]] : [],
    ),
  );

function toHttpError(error: unknown): HttpError {
  if (error instanceof ORPCError) {
    const issues = configIssues(error);

    return {
      message: error.message,
      statusCode: error.status,
      ...(issues.length > 0 && {
        errors: Object.fromEntries(issues.map((i) => [i.path, [i.message]])),
      }),
    };
  }

  return { message: toError(error).message, statusCode: 500 };
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error: unknown) {
    throw toHttpError(error);
  }
}

const required = <F>(fn: F | undefined, what: string): F => {
  if (fn === undefined) {
    throw new Error(`${what} is not supported`);
  }

  return fn;
};

// oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion, typescript/no-unnecessary-type-parameters -- Refine's caller picks TData; values come from the typed oRPC client
const asCallerType = <T>(value: unknown): T => value as T;

export const dataProvider: DataProvider = {
  getApiUrl: () => `${window.location.origin}/api`,

  getList: ({ resource, pagination, filters }) =>
    call(async () => {
      const pageSize = pagination?.pageSize ?? 20;
      const currentPage = pagination?.currentPage ?? 1;
      const off = pagination?.mode === 'off';
      const { data, total } = await adapter(resource).list({
        limit: off ? 200 : pageSize,
        offset: off ? 0 : (currentPage - 1) * pageSize,
        filters: filterObject(filters),
      });

      return { data: asCallerType([...data]), total };
    }),

  getOne: ({ resource, id }) =>
    call(async () => ({ data: asCallerType(await adapter(resource).getOne(String(id))) })),

  create: ({ resource, variables }) =>
    call(async () => ({
      data: asCallerType(await required(adapter(resource).create, `create ${resource}`)(variables)),
    })),

  update: ({ resource, id, variables }) =>
    call(async () => ({
      data: asCallerType(
        await required(adapter(resource).update, `update ${resource}`)(String(id), variables),
      ),
    })),

  deleteOne: ({ resource, id }) =>
    call(async () => ({
      data: asCallerType(
        await required(adapter(resource).deleteOne, `delete ${resource}`)(String(id)),
      ),
    })),
};
