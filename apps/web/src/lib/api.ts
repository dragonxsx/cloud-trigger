import { type Contract, contract } from '@cloud-trigger/api-contract';
import { createORPCClient } from '@orpc/client';
import { ClientRetryPlugin, type ClientRetryPluginContext } from '@orpc/client/plugins';
import type { ContractRouterClient } from '@orpc/contract';
import type { JsonifiedClient } from '@orpc/openapi-client';
import { OpenAPILink } from '@orpc/openapi-client/fetch';

import { accessToken } from './oidc';
import { passwordSession } from './session';
import { bestEffortStorage } from './storage';

const API_KEY = 'cloud-trigger.api-key';

export const auth = {
  apiKey: (): string | null => bestEffortStorage.get(API_KEY),
  setApiKey: (key: string | null): void => bestEffortStorage.set(API_KEY, key),
};

export type ApiClient = JsonifiedClient<ContractRouterClient<Contract, ClientRetryPluginContext>>;

const link = new OpenAPILink<ClientRetryPluginContext>(contract, {
  url: window.location.origin,
  headers: async () => {
    const token = (await accessToken()) ?? passwordSession.current();
    if (token) {
      return { authorization: `Bearer ${token}` };
    }
    const key = auth.apiKey();

    return key ? { 'x-api-key': key } : {};
  },
  plugins: [new ClientRetryPlugin()],
});

export const client: ApiClient = createORPCClient(link);

type Out<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;
export type JobDto = Out<ApiClient['jobs']['get']>;
export type RunDto = Out<ApiClient['runs']['get']>;
export type ProviderDto = Out<ApiClient['providers']['list']>[number];
export type SchedulePreviewDto = Out<ApiClient['jobs']['validate']>;
export type JobCreateInput = Parameters<ApiClient['jobs']['create']>[0];
export type ExtractSlotDto = Parameters<ApiClient['jobs']['extractConnection']>[0]['slot'];
export type RunStatusDto = RunDto['status'];
export type GroupDto = Out<ApiClient['groups']['get']>;
export type ConnectionDto = Out<ApiClient['connections']['get']>;
export type ConnectionSpecDto = Parameters<ApiClient['connections']['create']>[0];
export type ConnectionUsagesDto = Out<ApiClient['connections']['usages']>;
export type EnvironmentDto = Out<ApiClient['environments']['get']>;
export type WorkflowDto = Out<ApiClient['workflows']['get']>;
export type WorkflowRunDto = Out<ApiClient['workflowRuns']['get']>;
export type WorkflowSpecDto = Parameters<ApiClient['workflows']['create']>[0];
export type NodeStatusDto = WorkflowRunDto['nodes'][string]['status'];
export type SetupStatusDto = Out<ApiClient['setup']['status']>;
export type AuthSettingsDto = Out<ApiClient['authSettings']['get']>;
export type UserDto = Out<ApiClient['users']['get']>;
export type ApiKeyDto = Out<ApiClient['apiKeys']['list']>[number];
export type CreatedApiKeyDto = Out<ApiClient['apiKeys']['create']>;
export type AuthMethodsInput = Parameters<ApiClient['setup']['complete']>[0]['methods'];
