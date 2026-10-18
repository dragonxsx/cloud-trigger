import { type Contract, contract } from '@cloud-trigger/api-contract';
import { createORPCClient } from '@orpc/client';
import { ClientRetryPlugin, type ClientRetryPluginContext } from '@orpc/client/plugins';
import type { ContractRouterClient } from '@orpc/contract';
import type { JsonifiedClient } from '@orpc/openapi-client';
import { OpenAPILink } from '@orpc/openapi-client/fetch';

import { accessToken } from './oidc';
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
    const token = await accessToken();
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
export type RunStatusDto = RunDto['status'];
export type GroupDto = Out<ApiClient['groups']['get']>;
