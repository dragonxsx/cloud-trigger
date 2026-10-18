import { contract } from '@cloud-trigger/api-contract';
import { Controller, Inject } from '@nestjs/common';
import { Implement } from '@orpc/nest';

import { AnalyticsRouter } from './analytics.router.js';

@Controller()
export class AnalyticsController {
  constructor(@Inject(AnalyticsRouter) private readonly router: AnalyticsRouter) {}

  @Implement(contract.analytics)
  analytics() {
    return this.router.handlers;
  }
}
