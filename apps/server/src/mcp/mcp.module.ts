import { Module } from '@nestjs/common';

import { ApiModule } from '../api/api.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { McpController } from './mcp.controller.js';

@Module({
  imports: [ApiModule, AuthModule],
  controllers: [McpController],
})
export class McpModule {}
