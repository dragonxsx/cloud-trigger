import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import type { AppContext } from '../app-context.js';
import { headersOf } from '../feeds/feeds.controller.js';
import { APP_CONTEXT } from '../tokens.js';
import { buildMcpServer } from './mcp-server.js';
import { type AppRouter, appRouter } from './router.js';
import { TransportBridge } from './transport-bridge.js';

@Controller('mcp')
export class McpController {
  readonly #router: AppRouter;

  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {
    this.#router = appRouter(ctx);
  }

  @All()
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    const headers = headersOf(req);
    const principal = await this.ctx.authenticator.authenticate(headers);
    if (principal === 'missing' || principal === 'invalid') {
      res
        .status(401)
        .setHeader('WWW-Authenticate', 'Bearer')
        .json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Authentication required' },
          id: null,
        });

      return;
    }
    const server = buildMcpServer(this.#router, { principal, headers });
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(new TransportBridge(transport));
    await transport.handleRequest(req, res);
  }
}
