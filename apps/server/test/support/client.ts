import { type Contract, contract } from '@cloud-trigger/api-contract';
import { createORPCClient, safe } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import type { JsonifiedClient } from '@orpc/openapi-client';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { z } from 'zod';

export type Client = JsonifiedClient<ContractRouterClient<Contract>>;
type Run = Awaited<ReturnType<Client['runs']['get']>>;

export const createClient = (url: string, headers: Record<string, string> = {}): Client =>
  createORPCClient(new OpenAPILink(contract, { url, headers }));

const ErrorWithCode = z.object({ code: z.string() });

export const rejection = async (call: Promise<unknown>): Promise<unknown> =>
  (await safe(call)).error ?? undefined;

export const errorCode = async (call: Promise<unknown>): Promise<string | undefined> =>
  ErrorWithCode.safeParse(await rejection(call)).data?.code;

export const waitFor = async <T>(
  fn: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 10_000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

export const waitForRun = (api: Client, jobId: string): Promise<Run> =>
  waitFor(async () => {
    const [run] = (await api.runs.list({ jobId, limit: 1 })).items;

    return run && run.status !== 'pending' && run.status !== 'running' ? run : undefined;
  });

export const watchRunStatuses = async (
  api: Client,
  jobId: string,
  trigger: () => Promise<unknown>,
): Promise<string[]> => {
  const controller = new AbortController();
  const statuses: string[] = [];
  const stream = await api.runs.stream({ jobId }, { signal: controller.signal });
  const watching = (async () => {
    for await (const run of stream) {
      statuses.push(run.status);
      if (run.status === 'succeeded') {
        controller.abort();
      }
    }
  })().catch(() => undefined);
  await trigger();
  await Promise.race([watching, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  controller.abort();

  return statuses;
};
