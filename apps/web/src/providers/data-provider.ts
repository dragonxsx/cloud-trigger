import {
  ApiKeyIdParam,
  ConnectionListQuery,
  CreateApiKeyInput,
  CreateUserInput,
  EnvironmentKeyParam,
  RunListQuery,
  UpdateEnvironmentInput,
  UpdateUserInput,
  UserIdParam,
  UpdateConnectionInput,
  UpdateGroupInput,
  UpdateJobInput,
  UpdateWorkflowInput,
  WorkflowRunListQuery,
} from '@cloud-trigger/api-contract';
import {
  ConnectionKey,
  ConnectionSpec,
  EnvironmentSpec,
  GroupId,
  GroupSpec,
  JobId,
  JobSortField,
  JobSpec,
  RunId,
  SortOrder,
  WorkflowId,
  WorkflowRunId,
  WorkflowSpec,
} from '@cloud-trigger/core';
import { ORPCError } from '@orpc/client';
import type { BaseRecord, CrudFilter, CrudSort, DataProvider } from '@refinedev/core';
import { z } from 'zod';

import { client } from '../lib/api';
import { toHttpError } from '../lib/errors';

interface ListParams {
  limit: number;
  offset: number;
  filters: Record<string, unknown>;
  sorters: readonly CrudSort[];
  signal: AbortSignal | undefined;
}

const MAX_PAGE_SIZE = 200;

async function listAll(
  source: ResourceAdapter,
  params: Pick<ListParams, 'filters' | 'sorters' | 'signal'>,
): Promise<{ data: readonly BaseRecord[]; total: number }> {
  const data: BaseRecord[] = [];
  let total = 0;
  do {
    const page = await source.list({ ...params, limit: MAX_PAGE_SIZE, offset: data.length });
    data.push(...page.data);
    total = page.total;
    if (page.data.length === 0) {
      break;
    }
  } while (data.length < total);

  return { data, total };
}

const withSignal = (signal: AbortSignal | undefined) => (signal ? { signal } : {});

interface ResourceAdapter {
  readonly list: (p: ListParams) => Promise<{ data: readonly BaseRecord[]; total: number }>;
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
  environment: z.string().optional(),
});
const RunFilters = RunListQuery.pick({
  jobId: true,
  status: true,
  reason: true,
  late: true,
  acknowledged: true,
}).extend({
  late: z
    .union([z.boolean(), z.enum(['true', 'false']).transform((value) => value === 'true')])
    .optional(),
});

const JobSorter = z.object({ field: JobSortField, order: SortOrder });

const jobSort = (sorters: readonly CrudSort[]) => {
  const parsed = JobSorter.safeParse(sorters[0]);

  return parsed.success ? { sort: parsed.data.field, order: parsed.data.order } : {};
};

const jobs: ResourceAdapter = {
  list: async ({ limit, offset, filters, sorters, signal }) => {
    const page = await client.jobs.list(
      { limit, offset, ...JobFilters.parse(filters), ...jobSort(sorters) },
      withSignal(signal),
    );

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
  list: async ({ limit, offset, filters, signal }) => {
    const page = await client.groups.list(
      { limit, offset, ...GroupFilters.parse(filters) },
      withSignal(signal),
    );

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
  list: async ({ limit, offset, filters, signal }) => {
    const page = await client.connections.list(
      { limit, offset, ...ConnectionFilters.parse(filters) },
      withSignal(signal),
    );

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
  list: async ({ limit, offset, filters, signal }) => {
    const parsed = RunFilters.parse(filters);
    const page = await client.runs.list(
      {
        limit,
        offset,
        ...(parsed.jobId !== undefined && { jobId: parsed.jobId }),
        ...(parsed.status !== undefined && { status: parsed.status }),
        ...(parsed.reason !== undefined && { reason: parsed.reason }),
        ...(parsed.late !== undefined && { late: parsed.late }),
        ...(parsed.acknowledged !== undefined && { acknowledged: parsed.acknowledged }),
      },
      withSignal(signal),
    );

    return { data: page.items, total: page.total };
  },
  getOne: (id) => client.runs.get({ id: RunId.parse(id) }),
};

const WorkflowFilters = z.object({ search: z.string().optional() });

const workflows: ResourceAdapter = {
  list: async ({ limit, offset, filters, signal }) => {
    const page = await client.workflows.list(
      { limit, offset, ...WorkflowFilters.parse(filters) },
      withSignal(signal),
    );

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
  list: async ({ limit, offset, filters, signal }) => {
    const parsed = WorkflowRunFilters.parse(filters);
    const page = await client.workflowRuns.list(
      {
        limit,
        offset,
        ...(parsed.workflowId !== undefined && { workflowId: parsed.workflowId }),
        ...(parsed.status !== undefined && { status: parsed.status }),
      },
      withSignal(signal),
    );

    return { data: page.items, total: page.total };
  },
  getOne: (id) => client.workflowRuns.get({ id: WorkflowRunId.parse(id) }),
};

const SearchFilters = z.object({ search: z.string().optional() });

const withId = (variables: unknown, id: Record<string, string>) => ({
  ...z.record(z.string(), z.unknown()).parse(variables),
  ...id,
});

const users: ResourceAdapter = {
  list: async ({ limit, offset, filters, signal }) => {
    const page = await client.users.list(
      { limit, offset, ...SearchFilters.parse(filters) },
      withSignal(signal),
    );

    return { data: page.items, total: page.total };
  },
  getOne: (id) => client.users.get(UserIdParam.parse({ id })),
  create: (variables) => client.users.create(CreateUserInput.parse(variables)),
  update: (id, variables) => client.users.update(UpdateUserInput.parse(withId(variables, { id }))),
  deleteOne: async (id) => {
    await client.users.delete(UserIdParam.parse({ id }));

    return { id };
  },
};

const apiKeys: ResourceAdapter = {
  list: async ({ signal }) => {
    const keys = await client.apiKeys.list({}, withSignal(signal));

    return { data: keys, total: keys.length };
  },
  getOne: async (id) => {
    const found = (await client.apiKeys.list({})).find((key) => key.id === id);
    if (!found) {
      throw new ORPCError('NOT_FOUND', { message: 'API key not found' });
    }

    return found;
  },
  create: (variables) => client.apiKeys.create(CreateApiKeyInput.parse(variables)),
  deleteOne: async (id) => {
    await client.apiKeys.revoke(ApiKeyIdParam.parse({ id }));

    return { id };
  },
};

const environments: ResourceAdapter = {
  list: async ({ limit, offset, filters, signal }) => {
    const page = await client.environments.list(
      { limit, offset, ...SearchFilters.parse(filters) },
      withSignal(signal),
    );

    return { data: page.items.map((e) => ({ ...e, id: e.key })), total: page.total };
  },
  getOne: async (key) => {
    const environment = await client.environments.get(EnvironmentKeyParam.parse({ key }));

    return { ...environment, id: environment.key };
  },
  create: async (variables) => {
    const created = await client.environments.create(EnvironmentSpec.parse(variables));

    return { ...created, id: created.key };
  },
  update: async (key, variables) => {
    const updated = await client.environments.update(
      UpdateEnvironmentInput.parse(withId(variables, { key })),
    );

    return { ...updated, id: updated.key };
  },
  deleteOne: async (key) => {
    await client.environments.delete(EnvironmentKeyParam.parse({ key }));

    return { id: key };
  },
};

const RESOURCES: Readonly<Record<string, ResourceAdapter>> = {
  jobs,
  runs,
  groups,
  connections,
  workflows,
  'workflow-runs': workflowRuns,
  users,
  'api-keys': apiKeys,
  environments,
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

const QueryMeta = z.object({
  queryContext: z.object({ signal: z.instanceof(AbortSignal).optional() }).optional(),
});

const signalOf = (meta: unknown): AbortSignal | undefined => {
  const parsed = QueryMeta.safeParse(meta);

  return parsed.success ? parsed.data.queryContext?.signal : undefined;
};

async function call<T>(fn: () => Promise<T>, notFoundOnInvalid = false): Promise<T> {
  try {
    return await fn();
  } catch (error: unknown) {
    throw toHttpError(error, { notFoundOnInvalid });
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

  getList: ({ resource, pagination, filters, sorters, meta }) =>
    call(async () => {
      const pageSize = pagination?.pageSize ?? 20;
      const currentPage = pagination?.currentPage ?? 1;
      const source = adapter(resource);
      const params = {
        filters: filterObject(filters),
        sorters: sorters ?? [],
        signal: signalOf(meta),
      };
      const { data, total } =
        pagination?.mode === 'off'
          ? await listAll(source, params)
          : await source.list({ ...params, limit: pageSize, offset: (currentPage - 1) * pageSize });

      return { data: asCallerType([...data]), total };
    }),

  getOne: ({ resource, id }) =>
    call(async () => ({ data: asCallerType(await adapter(resource).getOne(String(id))) }), true),

  getMany: ({ resource, ids }) =>
    call(async () => {
      const source = adapter(resource);

      return {
        data: asCallerType(await Promise.all(ids.map((id) => source.getOne(String(id))))),
      };
    }, true),

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
