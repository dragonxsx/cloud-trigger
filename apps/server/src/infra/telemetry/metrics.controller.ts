import { Controller, Get, Header, Inject } from '@nestjs/common';

import { AppMetrics } from './metrics.js';

@Controller()
export class MetricsController {
  constructor(@Inject(AppMetrics) private readonly metrics: AppMetrics) {}

  @Get('metrics')
  @Header('content-type', 'text/plain; version=0.0.4')
  scrape(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
