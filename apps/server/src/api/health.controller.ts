import { Controller, Get, Header, HttpException, HttpStatus, Inject } from '@nestjs/common';

import type { AppContext } from '../app-context.js';
import { APP_CONTEXT } from '../tokens.js';

@Controller()
export class HealthController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  @Get('health/ready')
  async ready() {
    const db = await this.ctx.persistence.ping();
    if (!db) {
      throw new HttpException(
        { status: 'unavailable', checks: { db } },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    return { status: 'ok', checks: { db }, roles: this.ctx.config.APP_ROLE };
  }

  @Get('metrics')
  @Header('content-type', 'text/plain; version=0.0.4')
  metrics(): Promise<string> {
    return this.ctx.metrics.registry.metrics();
  }
}
