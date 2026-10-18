import { contract } from '@cloud-trigger/api-contract';
import { Controller, Inject } from '@nestjs/common';
import { Implement } from '@orpc/nest';

import { RunsRouter } from './runs.router.js';

@Controller()
export class RunsController {
  constructor(@Inject(RunsRouter) private readonly router: RunsRouter) {}

  @Implement(contract.runs)
  runs() {
    return this.router.handlers;
  }
}
