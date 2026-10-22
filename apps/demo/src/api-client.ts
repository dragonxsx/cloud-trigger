import { type Contract, contract } from '@cloud-trigger/api-contract';
import { createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import type { JsonifiedClient } from '@orpc/openapi-client';
import { OpenAPILink } from '@orpc/openapi-client/fetch';

export type ApiClient = JsonifiedClient<ContractRouterClient<Contract>>;

export const createApiClient = (url: string, headers: Record<string, string> = {}): ApiClient =>
  createORPCClient(new OpenAPILink(contract, { url, headers }));
