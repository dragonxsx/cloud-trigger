import { Controller, Get, HttpException, HttpStatus, Inject } from '@nestjs/common';

import { Readiness } from './readiness.js';

@Controller()
export class HealthController {
  constructor(@Inject(Readiness) private readonly readiness: Readiness) {}

  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  @Get('health/ready')
  async ready() {
    const db = await this.readiness.database();
    if (!db) {
      throw new HttpException(
        { status: 'unavailable', checks: { db } },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    return { status: 'ok', checks: { db }, roles: this.readiness.roles };
  }
}
