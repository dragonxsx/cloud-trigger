import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { ApiRouter } from '../api/app-router.js';
import { Authenticator, isAuthFailure } from '../auth/authenticator.js';
import { headersOf } from '../common/http/headers.js';
import { buildMcpServer } from './mcp-server.js';
import { TransportBridge } from './transport-bridge.js';

@Controller('mcp')
export class McpController {
  constructor(
    @Inject(Authenticator) private readonly authenticator: Authenticator,
    @Inject(ApiRouter) private readonly api: ApiRouter,
  ) {}

  @All()
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    const headers = headersOf(req);
    const principal = await this.authenticator.authenticate(headers);
    if (principal === 'setup_required') {
      res.status(503).json({
        jsonrpc: '2.0',
        error: { code: -32002, message: 'Finish the setup wizard first' },
        id: null,
      });

      return;
    }
    if (isAuthFailure(principal)) {
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
    const server = buildMcpServer(this.api.router, { principal, headers });
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(new TransportBridge(transport));
    await transport.handleRequest(req, res);
  }
}
