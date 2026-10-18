import { IdParam, RunIdParam } from '@cloud-trigger/api-contract';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type RouterClient, createRouterClient } from '@orpc/server';

import { hasScope } from '../auth/authenticator.js';
import { type McpRequestContext, registerContractTools } from './contract-tools.js';
import type { AppRouter } from './router.js';

type Client = RouterClient<AppRouter>;

const SERVER_INFO = { name: 'cloud-trigger', version: '1.0.0' };

export function buildMcpServer(router: AppRouter, request: McpRequestContext): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      'Cloud Trigger schedules jobs that call HTTP, gRPC, queue and other targets, and records every run. Use list_jobs and list_runs to look around, explain_job to see why a job did or did not run.',
  });
  const client: Client = createRouterClient(router, { context: { reqHeaders: request.headers } });

  registerContractTools(server, router, request);

  if (hasScope(request.principal, 'read')) {
    server.registerResource(
      'job',
      new ResourceTemplate('job://{id}', { list: undefined }),
      { description: 'A job as JSON, with secrets redacted.', mimeType: 'application/json' },
      async (uri, variables) => {
        const id = IdParam.shape.id.parse(variables['id']);

        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify(await client.jobs.get({ id })),
            },
          ],
        };
      },
    );
    server.registerResource(
      'run',
      new ResourceTemplate('run://{id}', { list: undefined }),
      { description: 'A run as JSON, with its attempts.', mimeType: 'application/json' },
      async (uri, variables) => {
        const id = RunIdParam.shape.id.parse(variables['id']);

        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify(await client.runs.get({ id })),
            },
          ],
        };
      },
    );
  }

  return server;
}
