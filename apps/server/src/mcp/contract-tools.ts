import { type ApiMeta, type Scope, contract } from '@cloud-trigger/api-contract';
import { toError } from '@cloud-trigger/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
  ToolSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  type AnySchema,
  ContractProcedure,
  type ContractRouter,
  type ErrorMap,
  getEventIteratorSchemaDetails,
} from '@orpc/contract';
import { ORPCError, call, getRouter, isProcedure, unlazy } from '@orpc/server';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';

import type { AppRouter } from '../api/app-router.js';
import { type Principal, hasScope } from '../auth/authenticator.js';

type ApiProcedure = ContractProcedure<AnySchema, AnySchema, ErrorMap, ApiMeta>;

export interface ContractTool {
  readonly path: readonly string[];
  readonly scope: Scope;
  readonly tool: Tool;
}

export interface McpRequestContext {
  readonly principal: Principal;
  readonly headers: Headers;
}

const converter = new ZodToJsonSchemaConverter();

const toolOf = (procedure: ApiProcedure, path: readonly string[]): ContractTool | undefined => {
  const { meta, route, inputSchema, outputSchema } = procedure['~orpc'];
  const { mcp } = meta;
  if (mcp === undefined) {
    return undefined;
  }
  if (getEventIteratorSchemaDetails(outputSchema) !== undefined) {
    throw new Error(`MCP tool ${mcp.name} (${path.join('.')}) streams events; tools cannot`);
  }
  const description = mcp.description ?? route.summary;
  const readOnly = meta.minimumScope === 'read';

  return {
    path,
    scope: meta.minimumScope,
    tool: {
      name: mcp.name,
      ...(description === undefined ? {} : { description }),
      inputSchema: ToolSchema.shape.inputSchema.parse(
        converter.convert(inputSchema, { strategy: 'input' })[1],
      ),
      annotations: readOnly
        ? { readOnlyHint: true }
        : { readOnlyHint: false, destructiveHint: mcp.destructive === true },
    },
  };
};

const collect = (node: ContractRouter<ApiMeta>, path: readonly string[]): ContractTool[] => {
  if (node instanceof ContractProcedure) {
    const tool = toolOf(node, path);

    return tool === undefined ? [] : [tool];
  }

  return Object.entries(node).flatMap(([key, child]) => collect(child, [...path, key]));
};

export function contractTools(router: ContractRouter<ApiMeta>): readonly ContractTool[] {
  const tools = collect(router, []);
  const duplicate = tools.find(
    (entry, index) => tools.findIndex((other) => other.tool.name === entry.tool.name) !== index,
  );
  if (duplicate !== undefined) {
    throw new Error(`MCP tool name ${duplicate.tool.name} is used twice`);
  }

  return tools;
}

export const CONTRACT_TOOLS = contractTools(contract);

const ok = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

const failure = (error: unknown): CallToolResult => ({
  isError: true,
  content: [
    {
      type: 'text',
      text:
        error instanceof ORPCError
          ? `${error.code}: ${error.message}${error.data === undefined ? '' : ` ${JSON.stringify(error.data)}`}`
          : toError(error).message,
    },
  ],
});

const procedureAt = async (router: AppRouter, path: readonly string[]) => {
  const { default: found } = await unlazy(getRouter(router, path));
  if (!isProcedure(found)) {
    throw new Error(`No procedure implements ${path.join('.')}`);
  }

  return found;
};

export function registerContractTools(
  server: McpServer,
  router: AppRouter,
  request: McpRequestContext,
): void {
  const visible = CONTRACT_TOOLS.filter((entry) => hasScope(request.principal, entry.scope));
  server.server.registerCapabilities({ tools: {} });
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: visible.map((entry) => entry.tool),
  }));
  server.server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const entry = visible.find((candidate) => candidate.tool.name === params.name);
    if (entry === undefined) {
      throw new McpError(ErrorCode.InvalidParams, `Tool ${params.name} not found`);
    }
    try {
      const procedure = await procedureAt(router, entry.path);

      return ok(
        await call(procedure, params.arguments ?? {}, {
          context: { reqHeaders: request.headers },
        }),
      );
    } catch (error: unknown) {
      return failure(error);
    }
  });
}
