import { contract } from '@cloud-trigger/api-contract';
import { Controller, Inject } from '@nestjs/common';
import { Implement } from '@orpc/nest';

import { JobsRouter } from './jobs.router.js';

@Controller()
export class JobsController {
  constructor(@Inject(JobsRouter) private readonly router: JobsRouter) {}

  @Implement(contract.jobs)
  jobs() {
    return this.router.handlers;
  }
}
